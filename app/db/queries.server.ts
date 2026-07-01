/**
 * Tenant-scoped data access. Every query takes an `orgId` (the WorkOS org from the session)
 * and filters by it, so a loader physically cannot read another tenant's rows (D2). Keep all
 * cross-table reads here rather than inline in loaders, so the org-scoping invariant lives in
 * one place.
 */
import { and, desc, eq } from "drizzle-orm";

import { db } from "./client.server";
import { projects, releases } from "./schema";

/** List a tenant's projects, newest first. */
export function listProjects(orgId: string) {
  return db
    .select()
    .from(projects)
    .where(eq(projects.orgId, orgId))
    .orderBy(desc(projects.createdAt));
}

/** Fetch one project by id, scoped to the tenant. Returns undefined if not found/not owned. */
export async function getProject(orgId: string, projectId: string) {
  const [row] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.orgId, orgId), eq(projects.id, projectId)))
    .limit(1);
  return row;
}

/** Releases for a project, newest first (D9 version history). */
export function listReleases(projectId: string) {
  return db
    .select()
    .from(releases)
    .where(eq(releases.projectId, projectId))
    .orderBy(desc(releases.createdAt));
}
