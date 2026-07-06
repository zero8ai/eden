/**
 * The assistant's authoring service — the business logic behind the `api/assistant/*` callback
 * endpoints (docs/ASSISTANT.md §6). Extracted from the old in-process OpenRouter loop
 * (`agent.server.ts`, removed): the file read/write, npm dependency (with the correct
 * --package-lock-only lockfile regeneration), and build-check tools, plus new cross-member
 * project-context / scaffold / catalog / bundle operations.
 *
 * Every dependency is injected (`AuthoringDeps`), like `app/team/ask.server.ts`, so the whole
 * surface unit-tests against an in-memory store with zero I/O. Endpoints return plain JSON-able
 * results; business failures come back as `{ ok: false, error }` (the route serves them at HTTP
 * 200 so the model reads the text). The assistant's ONLY write path is drafts — nothing here
 * ever touches git.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { DataStore } from "~/data/ports";
import {
  listDrafts as listDraftsDefault,
  resolveFileView as resolveFileViewDefault,
  stageDraft as stageDraftDefault,
  type FileView,
} from "~/drafts/drafts.server";
import { ASSISTANT_CONFIG_ROOT } from "~/eve/parse";
import { memberScaffold } from "~/github/create.server";
import { getAgentSource } from "~/github/cached.server";
import { readAgentFile } from "~/github/repo.server";
import { slugifyResourceName } from "~/eve/templates";
import type { ConnectedProject } from "~/project/guard.server";
import { isAssistantConfigPath, normalizeAgentPath } from "~/project/guard.server";
import { drizzleSecretKV } from "~/seams/oss/secret-store";
import { getRuntime } from "~/seams/index.server";
import type { BuildCheckRequest, BuildCheckResult, CatalogSource } from "~/seams/types";

const exec = promisify(execFile);

/** The subset of a connected project the authoring service reads. */
export type AuthoringProject = ConnectedProject;

/** Regenerate package.json + package-lock.json for an added dependency set. Injected for tests. */
export type ResolveManifests = (input: {
  packageJson: string;
  packageLock: string | null;
  packages: string[];
}) => Promise<{ packageJson: string; packageLock: string }>;

/** The build gate used by run-checks (the DeployTarget's checkBuild, or null when unavailable). */
export type CheckBuildFn = (req: BuildCheckRequest) => Promise<BuildCheckResult>;

export interface AuthoringDeps {
  store: DataStore;
  getSource: typeof getAgentSource;
  resolveFileView: typeof resolveFileViewDefault;
  stageDraft: typeof stageDraftDefault;
  listDrafts: typeof listDraftsDefault;
  /** Published (default-branch) content of a repo file, ignoring drafts (used by bundle). */
  readPublished: (project: AuthoringProject, path: string) => Promise<string | null>;
  resolveManifests: ResolveManifests;
  checkBuild: CheckBuildFn | null;
  /** Member-scoped secret names (never values), for project-context. */
  secretKeys: (input: { projectId: string; agentId: string }) => Promise<string[]>;
  catalog: CatalogSource;
}

/** npm resolves the new dependency set in a scratch dir (registry metadata only, no install). */
const npmResolveManifests: ResolveManifests = async ({ packageJson, packageLock, packages }) => {
  const dir = await mkdtemp(path.join(tmpdir(), "eden-assist-deps-"));
  try {
    await writeFile(path.join(dir, "package.json"), packageJson);
    if (packageLock !== null) {
      await writeFile(path.join(dir, "package-lock.json"), packageLock);
    }
    await exec(
      "npm",
      ["install", ...packages, "--package-lock-only", "--no-audit", "--no-fund"],
      { cwd: dir, timeout: 120_000 },
    );
    const [pkg, lock] = await Promise.all([
      readFile(path.join(dir, "package.json"), "utf8"),
      readFile(path.join(dir, "package-lock.json"), "utf8"),
    ]);
    return { packageJson: pkg, packageLock: lock };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

export function defaultAuthoringDeps(): AuthoringDeps {
  const runtime = getRuntime();
  return {
    store: runtime.data,
    getSource: getAgentSource,
    resolveFileView: resolveFileViewDefault,
    stageDraft: stageDraftDefault,
    listDrafts: listDraftsDefault,
    readPublished: (project, p) =>
      readAgentFile(
        project.repoInstallationId,
        { owner: project.repoOwner, repo: project.repoName },
        p,
      ),
    resolveManifests: npmResolveManifests,
    checkBuild: runtime.deployTarget.checkBuild
      ? (req) => runtime.deployTarget.checkBuild!(req)
      : null,
    secretKeys: ({ projectId, agentId }) =>
      drizzleSecretKV
        .listKeys({ projectId, agentId, environmentId: null })
        .catch(() => []),
    catalog: runtime.catalog,
  };
}

// ── Caller resolution ────────────────────────────────────────────────────────

export interface AssistantContext {
  project: AuthoringProject;
  agentId: string;
  deploymentId: string;
}

/**
 * Resolve the assistant caller from a token-verified deployment id: deployment → environment →
 * agent (must be kind 'assistant') → project. Returns null if anything is missing or the agent
 * is not the built-in assistant (so a leaked non-assistant deployment token can't reach these).
 */
export async function resolveAssistantContext(
  deploymentId: string,
  store: DataStore,
): Promise<AssistantContext | null> {
  const deployment = await store.deployments.findById(deploymentId);
  if (!deployment) return null;
  const env = await store.environments.findById(deployment.environmentId);
  if (!env) return null;
  const agent = await store.agents.findById(env.agentId);
  if (!agent || agent.kind !== "assistant") return null;
  const project = await store.projects.findById(agent.projectId);
  if (!project || !project.repoInstallationId || !project.repoOwner || !project.repoName) {
    return null;
  }
  return {
    project: project as AuthoringProject,
    agentId: agent.id,
    deploymentId,
  };
}

// ── Results ──────────────────────────────────────────────────────────────────

type Ok<T> = { ok: true } & T;
type Result<T> = Ok<T> | { ok: false; error: string };
const fail = (error: string) => ({ ok: false as const, error });

// ── Write-path policy (server-enforced, regardless of what the model sends) ────

/**
 * What the ASSISTANT MODEL may write via callback: any member file (`agent/**`,
 * `agents/<m>/agent/**`), plus its own `.eden/assistant/{instructions.md, skills/*.md,
 * schedules/*.md}`. NEVER the package manifests (use add-dependency), NEVER `assistant.json`
 * (the model doesn't set its own model — a human does on the config page), NEVER any `.ts` under
 * `.eden/assistant/` (the fixed tool/agent layer is Eden-owned).
 */
function resolveWritePath(raw: string): { path: string } | { error: string } {
  const p = normalizeAgentPath(raw);
  if (!p) return { error: `Path is not editable from Eden: ${raw}` };
  if (p.endsWith("package.json") || p.endsWith("package-lock.json")) {
    return { error: "Use add_dependency for dependency changes — never write the manifest directly." };
  }
  if (p === `${ASSISTANT_CONFIG_ROOT}/assistant.json`) {
    return { error: "You can't change your own model — a human sets it on the assistant config page." };
  }
  return { path: p };
}

// ── Endpoints ──────────────────────────────────────────────────────────────────

export async function listFiles(
  project: AuthoringProject,
  deps: AuthoringDeps,
): Promise<Result<{ files: { path: string; staged: boolean }[] }>> {
  const [source, drafts] = await Promise.all([
    deps.getSource(project.repoInstallationId, {
      owner: project.repoOwner,
      repo: project.repoName,
    }),
    deps.listDrafts(project.id),
  ]);
  const staged = new Set(drafts.map((d) => d.path));
  const all = new Set([...source.paths, "package.json", ...staged]);
  const files = [...all]
    .sort()
    .map((path) => ({ path, staged: staged.has(path) }));
  return { ok: true, files };
}

export async function readFile_(
  project: AuthoringProject,
  rawPath: string,
  deps: AuthoringDeps,
): Promise<Result<{ path: string; content: string; source: FileView["source"] }>> {
  const p = normalizeAgentPath(rawPath);
  if (!p) return fail(`Path is not readable from Eden: ${rawPath}`);
  const view = await deps.resolveFileView(project, p);
  if (view.content === null) return fail(`${p} does not exist.`);
  return { ok: true, path: p, content: view.content, source: view.source };
}

export async function writeFile_(
  project: AuthoringProject,
  rawPath: string,
  content: string,
  deps: AuthoringDeps,
): Promise<Result<{ path: string; bytes: number }>> {
  const resolved = resolveWritePath(rawPath);
  if ("error" in resolved) return fail(resolved.error);
  await deps.stageDraft({ projectId: project.id, path: resolved.path, content, createdBy: null });
  return { ok: true, path: resolved.path, bytes: content.length };
}

export async function deleteFile_(
  project: AuthoringProject,
  rawPath: string,
  deps: AuthoringDeps,
): Promise<Result<{ path: string }>> {
  const resolved = resolveWritePath(rawPath);
  if ("error" in resolved) return fail(resolved.error);
  await deps.stageDraft({ projectId: project.id, path: resolved.path, content: null, createdBy: null });
  return { ok: true, path: resolved.path };
}

const PKG_SPEC = /^(@?[\w.-]+\/)?[\w.-]+(@[\w^~><=.*-]+)?$/;

/** Repo-relative manifest prefix for a member's agent root ("agent" → "", "agents/pm/agent" → "agents/pm/"). */
function manifestPrefixForRoot(agentRoot: string): string {
  if (agentRoot === "agent") return "";
  return `${path.posix.dirname(agentRoot)}/`;
}

export async function addDependency(
  project: AuthoringProject,
  input: { packages: string[]; agentRoot?: string },
  deps: AuthoringDeps,
): Promise<Result<{ packages: string[]; staged: string[] }>> {
  const packages = input.packages ?? [];
  if (packages.length === 0) return fail("No packages given.");
  if (packages.some((p) => !PKG_SPEC.test(p))) {
    return fail(`Invalid package spec in: ${packages.join(", ")}`);
  }
  const prefix = manifestPrefixForRoot(input.agentRoot ?? "agent");
  const pkgPath = `${prefix}package.json`;
  const lockPath = `${prefix}package-lock.json`;
  const [pkgView, lockView] = await Promise.all([
    deps.resolveFileView(project, pkgPath),
    deps.resolveFileView(project, lockPath),
  ]);
  if (pkgView.content === null) return fail(`The repo has no ${pkgPath}.`);
  try {
    const { packageJson, packageLock } = await deps.resolveManifests({
      packageJson: pkgView.content,
      packageLock: lockView.content,
      packages,
    });
    await deps.stageDraft({ projectId: project.id, path: pkgPath, content: packageJson, createdBy: null });
    await deps.stageDraft({ projectId: project.id, path: lockPath, content: packageLock, createdBy: null });
    return { ok: true, packages, staged: [pkgPath, lockPath] };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return fail(`npm could not resolve ${packages.join(", ")}: ${msg.split("\n").slice(0, 6).join("\n")}`);
  }
}

/** The member root a member-file draft belongs to (single root if all drafts share one). */
async function inferBuildRoot(
  project: AuthoringProject,
  drafts: { path: string }[],
  deps: AuthoringDeps,
): Promise<string | undefined> {
  const agents = await deps.store.agents.listByProject(project.id);
  let root: string | undefined;
  for (const d of drafts) {
    if (isAssistantConfigPath(d.path)) continue; // config isn't part of any eve build
    const owner = agents
      .filter((a) => a.kind === "member")
      .filter((a) => d.path === a.root || d.path.startsWith(`${a.root}/`))
      .sort((a, b) => b.root.length - a.root.length)[0];
    const memberRoot =
      owner?.root ??
      (d.path.match(/^agents\/([^/]+)\/(agent\/|package)/)
        ? `agents/${d.path.split("/")[1]}/agent`
        : undefined);
    if (!memberRoot) return undefined;
    if (root && root !== memberRoot) return undefined;
    root = memberRoot;
  }
  return root;
}

export async function runChecks(
  project: AuthoringProject,
  deps: AuthoringDeps,
): Promise<Result<{ ran: boolean; passed: boolean; output?: string; skipped?: boolean }>> {
  const drafts = await deps.listDrafts(project.id);
  // Assistant-only changesets (.eden/assistant/** markdown) are not part of any eve build.
  if (drafts.length > 0 && drafts.every((d) => isAssistantConfigPath(d.path))) {
    return { ok: true, ran: false, passed: true, skipped: true };
  }
  if (!deps.checkBuild) {
    return { ok: true, ran: false, passed: true, skipped: true };
  }
  const agentRoot = await inferBuildRoot(project, drafts, deps);
  const res = await deps.checkBuild({
    projectId: project.id,
    repo: { owner: project.repoOwner, repo: project.repoName },
    ref: project.defaultBranch,
    installationId: project.repoInstallationId,
    overlay: drafts
      .filter((d) => !isAssistantConfigPath(d.path))
      .map((d) => ({ path: d.path, content: d.content })),
    agentRoot,
  });
  return res.ok
    ? { ok: true, ran: true, passed: true }
    : { ok: true, ran: true, passed: false, output: res.output };
}

export async function scaffoldMember(
  project: AuthoringProject,
  rawName: string,
  deps: AuthoringDeps,
): Promise<Result<{ member: string; staged: string[] }>> {
  const name = slugifyResourceName(rawName ?? "");
  if (!name) return fail("Give the new member a name.");
  if (name === "assistant") {
    return fail(`"assistant" is reserved for me — pick another name for the member.`);
  }
  const agents = await deps.store.agents.listByProject(project.id);
  if (agents.some((a) => a.name === name)) {
    return fail(`A member named "${name}" already exists.`);
  }
  const files = memberScaffold(name);
  for (const f of files) {
    await deps.stageDraft({ projectId: project.id, path: f.path, content: f.content, createdBy: null });
  }
  return { ok: true, member: name, staged: files.map((f) => f.path) };
}

export async function projectContext(
  project: AuthoringProject,
  deps: AuthoringDeps,
): Promise<
  Result<{
    isTeam: boolean;
    members: { name: string; root: string; secretNames: string[] }[];
    assistantConfig: {
      instructions: boolean;
      skills: string[];
      schedules: string[];
      model: string | null;
    };
    stagedDrafts: { path: string; deletion: boolean }[];
  }>
> {
  const agents = (await deps.store.agents.listByProject(project.id)).filter(
    (a) => a.kind === "member",
  );
  const isTeam = agents.some((a) => a.root !== "agent");
  const members = await Promise.all(
    agents.map(async (a) => ({
      name: a.name,
      root: a.root,
      secretNames: await deps.secretKeys({ projectId: project.id, agentId: a.id }),
    })),
  );
  const bundle = await assembleBundle(project, deps);
  const drafts = await deps.listDrafts(project.id);
  return {
    ok: true,
    isTeam,
    members,
    assistantConfig: {
      instructions: bundle.instructions !== null,
      skills: Object.keys(bundle.files)
        .filter((p) => p.startsWith("skills/user/"))
        .map((p) => path.posix.basename(p)),
      schedules: Object.keys(bundle.files)
        .filter((p) => p.startsWith("schedules/user/"))
        .map((p) => path.posix.basename(p)),
      model: bundle.model,
    },
    stagedDrafts: drafts.map((d) => ({ path: d.path, deletion: d.content === null })),
  };
}

export async function catalogOp(
  input: { op: string; type?: string; id?: string },
  deps: AuthoringDeps,
): Promise<Result<{ index?: unknown; template?: unknown }>> {
  if (input.op === "index") {
    return { ok: true, index: await deps.catalog.index() };
  }
  if (input.op === "template") {
    if (!input.type || !input.id) return fail("template lookup needs a type and id.");
    try {
      const template = await deps.catalog.template(
        input.type as "agent" | "skill" | "tool",
        input.id,
      );
      return { ok: true, template };
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  }
  return fail(`Unknown catalog op "${input.op}" (expected "index" or "template").`);
}

// ── Bundle (entrypoint materialization; published config only) ─────────────────

export interface AssistantBundle {
  /** Published `.eden/assistant/instructions.md`, or null. */
  instructions: string | null;
  /** agent-relative target path → content (skills/user/*, schedules/user/*). */
  files: Record<string, string>;
  /** Per-project model override from `.eden/assistant/assistant.json`, or null. */
  model: string | null;
}

export async function assembleBundle(
  project: AuthoringProject,
  deps: AuthoringDeps,
): Promise<AssistantBundle> {
  const source = await deps.getSource(project.repoInstallationId, {
    owner: project.repoOwner,
    repo: project.repoName,
  });
  const prefix = `${ASSISTANT_CONFIG_ROOT}/`;
  const configPaths = source.paths.filter((p) => p.startsWith(prefix));

  const files: Record<string, string> = {};
  let model: string | null = null;
  let instructions: string | null = null;

  await Promise.all(
    configPaths.map(async (p) => {
      const content = await deps.readPublished(project, p);
      if (content === null) return;
      const rel = p.slice(prefix.length);
      if (rel === "instructions.md") {
        instructions = content;
      } else if (rel.startsWith("skills/") && rel.endsWith(".md")) {
        files[`skills/user/${path.posix.basename(rel)}`] = content;
      } else if (rel.startsWith("schedules/") && rel.endsWith(".md")) {
        files[`schedules/user/${path.posix.basename(rel)}`] = content;
      } else if (rel === "assistant.json") {
        try {
          const parsed = JSON.parse(content) as { model?: unknown };
          if (typeof parsed.model === "string" && parsed.model.trim()) {
            model = parsed.model.trim();
          }
        } catch {
          // ignore a malformed override — the instance falls back to the env default.
        }
      }
    }),
  );

  return { instructions, files, model };
}
