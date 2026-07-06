/**
 * Shared loader/action guards for project routes. Centralizes the "resolve the tenant, load
 * the org-scoped project, require a connected repo" steps so every editor/route enforces the
 * same tenant-isolation + connected-repo invariants.
 */
import { data } from "react-router";

import { syncTenant, type SessionAuth } from "~/auth/tenant.server";
import { getProject, type Project } from "~/db/queries.server";
import { ASSISTANT_CONFIG_ROOT } from "~/eve/parse";

/** A project guaranteed to have a connected GitHub repo. */
export type ConnectedProject = Project & {
  repoInstallationId: string;
  repoOwner: string;
  repoName: string;
};

/** Sync the session's tenant and load the org-scoped project, or throw 403/404. */
export async function requireProject(
  auth: SessionAuth,
  projectId: string | undefined,
): Promise<Project> {
  const { org } = await syncTenant(auth);
  if (!org) throw data("No organization", { status: 403 });
  const project = projectId ? await getProject(org.id, projectId) : undefined;
  if (!project) throw data("Project not found", { status: 404 });
  return project;
}

/** Narrow a project to one with a connected repo, or throw 400. */
export function requireRepo(project: Project): ConnectedProject {
  if (!project.repoInstallationId || !project.repoOwner || !project.repoName) {
    throw data("Project has no connected repo", { status: 400 });
  }
  return project as ConnectedProject;
}

/**
 * Validate a user-supplied repo path stays within the editable surface — the root `agent/`
 * directory, a team member's `agents/<member>/agent/` (PRD §7.9), or the built-in assistant's
 * user-config surface under `.eden/assistant/`. Prevents editing files
 * outside those and path-traversal. Returns the normalized path or null if invalid.
 */
const ROOT_FILE_ALLOWLIST = new Set(["package.json", "package-lock.json"]);
const MEMBER_PATH = /^agents\/[A-Za-z0-9][\w.-]*\/(agent\/.+|package\.json|package-lock\.json)$/;

/** The assistant's user-config surface: markdown config + the JSON model override, never code. */
export { ASSISTANT_CONFIG_ROOT };
const ASSISTANT_CONFIG_PATH =
  /^\.eden\/assistant\/(instructions\.md|(?:skills|schedules)\/[A-Za-z0-9][\w.-]*\.md|assistant\.json)$/;

export function isAssistantConfigPath(path: string): boolean {
  return ASSISTANT_CONFIG_PATH.test(path);
}

export function normalizeAgentPath(raw: string): string | null {
  const p = raw.trim().replace(/^\/+/, "");
  if (p.includes("..") || p.endsWith("/")) return null;
  // Change-sets may carry the dependency manifest (a tool can need an npm package); anything
  // else outside the agent surface (CI config, Dockerfile, app code) stays off-limits.
  if (ROOT_FILE_ALLOWLIST.has(p)) return p;
  if (p.startsWith("agent/")) return p;
  if (MEMBER_PATH.test(p)) return p;
  if (ASSISTANT_CONFIG_PATH.test(p)) return p;
  return null;
}
