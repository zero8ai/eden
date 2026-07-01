/**
 * Tenant-scoped data access. Every query takes an `orgId` (the WorkOS org from the session)
 * and filters by it, so a loader physically cannot read another tenant's rows (D2). Keep all
 * cross-table reads here rather than inline in loaders, so the org-scoping invariant lives in
 * one place.
 */
import { and, desc, eq } from "drizzle-orm";

import { db } from "./client.server";
import { projects, releases } from "./schema";

export type Project = typeof projects.$inferSelect;
type NewProject = typeof projects.$inferInsert;

/** Turn a repo name into a URL-safe slug. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/**
 * Create a project (a connected eve repo) for a tenant. `slug` is unique per org; on
 * collision we suffix `-2`, `-3`, … so connecting two repos with similar names doesn't fail.
 */
export async function createProject(input: Omit<NewProject, "slug"> & { slug?: string }) {
  const base = slugify(input.slug ?? input.name);
  let slug = base || "agent";
  for (let n = 2; ; n++) {
    const existing = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.orgId, input.orgId), eq(projects.slug, slug)))
      .limit(1);
    if (existing.length === 0) break;
    slug = `${base}-${n}`;
  }
  const [row] = await db
    .insert(projects)
    .values({ ...input, slug })
    .returning();
  return row;
}

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
