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

/** Environments every roster member gets, in display order. */
const DEFAULT_ENVIRONMENTS = ["production", "preview", "development"] as const;

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
 * team of one, PRD §7.9) and seeding default environments per member. `slug` is unique per
 * org; on collision we suffix so connecting similarly-named repos doesn't fail.
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
    agents.map((a) => store.environments.seedDefaults(project.id, a.id, DEFAULT_ENVIRONMENTS)),
  );
  return project;
}

/** A project's roster, by name. */
export function listAgents(
  projectId: string,
  store: DataStore = getRuntime().data,
): Promise<Agent[]> {
  return store.agents.listByProject(projectId);
}

/**
 * Reconcile the roster with the repo's detected layout (connect revisit, webhook). New
 * members get default environments; removed members cascade away.
 */
export async function syncProjectAgents(
  projectId: string,
  roster: { name: string; root: string }[],
  store: DataStore = getRuntime().data,
): Promise<Agent[]> {
  const agents = await store.agents.syncRoster(projectId, roster);
  await Promise.all(
    agents.map((a) => store.environments.seedDefaults(projectId, a.id, DEFAULT_ENVIRONMENTS)),
  );
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
