/**
 * Shared loader/action guards for project routes. Centralizes the "resolve the tenant, load
 * the org-scoped project, require a connected repo" steps so every editor/route enforces the
 * same tenant-isolation + connected-repo invariants.
 */
import { data } from "react-router";

import { syncTenant, type SessionAuth } from "~/auth/tenant.server";
import { getProject, type Project } from "~/db/queries.server";

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
 * Validate a user-supplied repo path stays within the agent surface. Prevents editing files
 * outside `agent/` and path-traversal. Returns the normalized path or null if invalid.
 */
export function normalizeAgentPath(raw: string): string | null {
  const p = raw.trim().replace(/^\/+/, "");
  if (!p.startsWith("agent/")) return null;
  if (p.includes("..") || p.endsWith("/")) return null;
  return p;
}
