/**
 * Tenant-scoped data access. Every read takes an `orgId` (the WorkOS org from the session) and
 * filters by it, so a loader physically cannot read another tenant's rows (D2). These are thin
 * wrappers over the DataStore seam (app/data/ports.ts) — the org-scoping and slug-uniqueness
 * logic lives here in one place; the SQL lives in the Drizzle store; both are unit-testable
 * against an in-memory fake.
 */
import type { Agent, DataStore, Environment, Project } from "~/data/ports";
import { getRuntime } from "~/seams/index.server";

export type { Agent, Project, Environment } from "~/data/ports";

/** The default roster for a repo whose layout is unknown/single: a team of one. */
export const SINGLE_AGENT_ROSTER = [{ name: "agent", root: "agent" }] as const;

/** Turn a repo name into a URL-safe slug. */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/**
 * Resolve a slug that's unique within the org: start from `base`, then suffix `-2`, `-3`, …
 * until `exists` reports it free. Pure but for the injected predicate, so it's unit-testable.
 */
export async function resolveUniqueSlug(
  base: string,
  exists: (slug: string) => Promise<boolean>,
): Promise<string> {
  const root = base || "agent";
  let slug = root;
  for (let n = 2; await exists(slug); n++) {
    slug = `${root}-${n}`;
  }
  return slug;
}

/**
 * Create a project (a connected eve repo) for a tenant, creating its agent roster (single =
 * team of one, PRD §7.9). Each member starts with ONE environment ("default" — renamable;
 * environments are user-defined, M5.7). `slug` is unique per org; on collision we suffix so
 * connecting similarly-named repos doesn't fail.
 */
export async function createProject(
  input: {
    orgId: string;
    name: string;
    slug?: string;
    repoOwner?: string | null;
    repoName?: string | null;
    repoInstallationId?: string | null;
    defaultBranch?: string;
    /** Detected roster (detectAgentRoots); defaults to a single root agent. */
    roster?: { name: string; root: string }[];
  },
  store: DataStore = getRuntime().data,
): Promise<Project> {
  const slug = await resolveUniqueSlug(slugify(input.slug ?? input.name), (s) =>
    store.projects.slugExists(input.orgId, s),
  );
  const { slug: _ignore, roster: rosterInput, ...rest } = input;
  const project = await store.projects.create({ ...rest, slug });
  const roster = rosterInput?.length ? rosterInput : [...SINGLE_AGENT_ROSTER];
  const agents = await store.agents.syncRoster(project.id, roster);
  await Promise.all(
    agents.map((a) => store.environments.ensureDefault(project.id, a.id)),
  );
  return project;
}

/**
 * A project's ROSTER — the user-facing members (`kind === 'member'`), by name. The built-in
 * assistant (`kind === 'assistant'`) is never a roster member, so it is filtered out here; this
 * is the single choke point that keeps it off team cards, the member switcher, delegation
 * targeting, and `resolveAgentContext`'s active-member selection. Surfaces that legitimately
 * need the assistant row (drafts / `agentForPath`, the assistant instance service) read
 * `store.agents.listByProject` / `findAssistantAgent` directly.
 */
export async function listAgents(
  projectId: string,
  store: DataStore = getRuntime().data,
): Promise<Agent[]> {
  const all = await store.agents.listByProject(projectId);
  return all.filter((a) => a.kind === "member");
}

/** Every agent row including internal ones (assistant) — for drafts attribution and the like. */
export function listAllAgents(
  projectId: string,
  store: DataStore = getRuntime().data,
): Promise<Agent[]> {
  return store.agents.listByProject(projectId);
}

/** The project's built-in assistant agent row, or null. */
export function findAssistantAgent(
  projectId: string,
  store: DataStore = getRuntime().data,
): Promise<Agent | null> {
  return store.agents.findAssistant(projectId);
}

/**
 * Layout detection names the root-layout member "agent", but the human may have given it a
 * real name at create time — the directory convention can't carry it. Preserve the existing
 * name for the root member so a sync never clobbers it. Team members are named by their
 * directory, so they pass through untouched.
 */
export function withPreservedNames(
  existing: Agent[],
  detected: { name: string; root: string }[],
): { name: string; root: string }[] {
  const rootMember = existing.find((a) => a.root === "agent");
  return detected.map((d) =>
    d.root === "agent" && rootMember ? { name: rootMember.name, root: d.root } : d,
  );
}

/**
 * Decide how a pending member rename maps onto a freshly-detected roster. A rename is "in flight"
 * when a member row carries `pendingName` (its `eden/rename-member-*` PR is open). We map the row
 * IN PLACE — preserving its id and all FKs — only when the merge is unambiguous:
 *
 *  - `apply`: the pending target directory is now detected AND the old directory is gone → the
 *    rename PR merged. Rename the row to the target name/root and clear `pendingName`.
 *  - `clear`: BOTH the old and the new directory are detected as separate members → the pending
 *    name is stale (e.g. the PR was closed and a genuinely new member later took that name). Drop
 *    the pending mark so it can never hijack that unrelated member.
 *  - otherwise (old present, new absent): the PR hasn't merged — leave the pending mark untouched.
 *
 * Pure over its inputs (the store does the writes), so the mapping rule is unit-testable.
 */
export function planPendingRenames(
  existing: Agent[],
  detected: { name: string; root: string }[],
): {
  apply: { id: string; oldName: string; newName: string; root: string }[];
  clear: string[];
} {
  const detectedByName = new Map(detected.map((d) => [d.name, d]));
  const apply: { id: string; oldName: string; newName: string; root: string }[] = [];
  const clear: string[] = [];
  for (const row of existing) {
    if (row.kind !== "member" || !row.pendingName) continue;
    const target = detectedByName.get(row.pendingName);
    if (!target) continue; // new directory not present yet — PR unmerged, or row being pruned.
    if (detectedByName.has(row.name)) {
      clear.push(row.id); // old dir still present too → stale pending mark.
    } else {
      apply.push({
        id: row.id,
        oldName: row.name,
        newName: row.pendingName,
        root: target.root,
      });
    }
  }
  return { apply, clear };
}

/** Restage a renamed member's staged drafts under the new `agents/<new>/…` path prefix. */
async function rewriteMemberDraftPaths(
  projectId: string,
  oldName: string,
  newName: string,
  agentId: string,
  store: DataStore,
): Promise<void> {
  const prefix = `agents/${oldName}/`;
  const affected = (await store.drafts.listByProject(projectId)).filter((d) =>
    d.path.startsWith(prefix),
  );
  if (affected.length === 0) return;
  for (const d of affected) {
    await store.drafts.upsert({
      projectId,
      agentId,
      path: `agents/${newName}/${d.path.slice(prefix.length)}`,
      content: d.content,
      baseSha: d.baseSha,
      createdBy: d.createdBy,
    });
  }
  await store.drafts.deleteByPaths(
    projectId,
    affected.map((d) => d.path),
  );
}

/**
 * Reconcile the roster with the repo's detected layout (connect revisit, webhook). New
 * members get their one "default" environment; members that already have environments —
 * whatever the user renamed or created — are left strictly alone, so the self-heal that
 * runs on every Overview load can never re-seed. Removed members cascade away; the root
 * member's human-given name survives detection.
 *
 * This is also the SHIP POINT for pending install secrets (PLAN-SECRETS-REWORK §4.4): a
 * new-member install holds its secrets sealed until the member's agents row exists — which
 * happens exactly here, when the merged `agents/<name>/` directory is first detected. Held
 * values migrate into the member's real secret rows and the pending rows are deleted.
 */
export async function syncProjectAgents(
  projectId: string,
  roster: { name: string; root: string }[],
  store: DataStore = getRuntime().data,
): Promise<Agent[]> {
  const existing = await store.agents.listByProject(projectId);
  const existingNames = new Set(existing.map((a) => a.name));

  // A pending rename (open eden/rename-member-* PR) whose merge just landed must be mapped IN
  // PLACE — otherwise syncRoster would prune the old-named row (cascading its environments,
  // releases, secrets and drafts away) and insert a bare new row. Apply the in-place renames
  // BEFORE syncRoster so its upsert matches the row by its new name and the prune leaves it be.
  const { apply: renames, clear: staleRenames } = planPendingRenames(existing, roster);
  for (const id of staleRenames) await store.agents.setPendingName(id, null);
  for (const r of renames) {
    await store.agents.rename(r.id, { name: r.newName, root: r.root });
    // The row's id is unchanged, so agent-keyed rows (secrets, releases, envs) already follow.
    // The two name-keyed carries need moving: staged drafts under the old member directory, and
    // any still-held pending install secrets → the now-existing agent's real secrets.
    await rewriteMemberDraftPaths(projectId, r.oldName, r.newName, r.id, store);
    try {
      const { migratePendingSecrets } = await import("~/project/secrets.server");
      await migratePendingSecrets({ projectId, memberName: r.oldName, agentId: r.id });
    } catch (error) {
      console.warn(`[secrets] rename migration failed for ${r.oldName}→${r.newName}:`, error);
    }
    // The renamed member is not "created" — its held secrets were handled above.
    existingNames.add(r.newName);
  }

  const agents = await store.agents.syncRoster(
    projectId,
    withPreservedNames(existing, roster),
  );
  await Promise.all(
    agents.map((a) => store.environments.ensureDefault(projectId, a.id)),
  );
  const created = agents.filter((a) => !existingNames.has(a.name));
  if (created.length > 0) {
    const { migratePendingSecrets } = await import("~/project/secrets.server");
    for (const agent of created) {
      try {
        await migratePendingSecrets({
          projectId,
          memberName: agent.name,
          agentId: agent.id,
        });
      } catch (error) {
        // Never let a secrets hiccup break roster sync; held rows remain for the next sync.
        console.warn(`[secrets] pending migration failed for ${agent.name}:`, error);
      }
    }
  }
  return agents;
}

/**
 * The roster member a repo path belongs to — longest matching root wins ("agent" vs
 * "agents/pm/agent" can't actually collide, but be precise anyway). Null when the path is
 * outside every member (e.g. root package.json).
 */
export function agentForPath(agents: Agent[], path: string): Agent | null {
  let best: Agent | null = null;
  for (const a of agents) {
    if (path === a.root || path.startsWith(`${a.root}/`)) {
      if (!best || a.root.length > best.root.length) best = a;
    }
  }
  return best;
}

/** Environments for a project, in creation order (all roster members). */
export function listEnvironments(
  projectId: string,
  store: DataStore = getRuntime().data,
): Promise<Environment[]> {
  return store.environments.listByProject(projectId);
}

/** Environments for one roster member, in creation order. */
export function listAgentEnvironments(
  agentId: string,
  store: DataStore = getRuntime().data,
): Promise<Environment[]> {
  return store.environments.listByAgent(agentId);
}

/** List a tenant's projects, newest first. */
export function listProjects(orgId: string, store: DataStore = getRuntime().data) {
  return store.projects.listByOrg(orgId);
}

/** Fetch one project by id, scoped to the tenant. Returns undefined if not found/not owned. */
export async function getProject(
  orgId: string,
  projectId: string,
  store: DataStore = getRuntime().data,
): Promise<Project | undefined> {
  return (await store.projects.getByOrg(orgId, projectId)) ?? undefined;
}

/** Releases for a project, newest first (D9 version history). */
export function listReleases(projectId: string, store: DataStore = getRuntime().data) {
  return store.releases.listByProject(projectId);
}
