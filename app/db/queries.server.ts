/**
 * Tenant-scoped data access. Every read takes an `orgId` (the WorkOS org from the session) and
 * filters by it, so a loader physically cannot read another tenant's rows (D2). These are thin
 * wrappers over the DataStore seam (app/data/ports.ts) — the org-scoping and slug-uniqueness
 * logic lives here in one place; the SQL lives in the Drizzle store; both are unit-testable
 * against an in-memory fake.
 */
import type { DataStore, Environment, Project } from "~/data/ports";
import { getRuntime } from "~/seams/index.server";

export type { Project, Environment } from "~/data/ports";

/** Environments every new project gets, in display order. */
export const DEFAULT_ENVIRONMENTS = ["production", "preview", "development"] as const;

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
 * Create a project (a connected eve repo) for a tenant, seeding its default environments.
 * `slug` is unique per org; on collision we suffix so connecting similarly-named repos doesn't
 * fail.
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
  },
  store: DataStore = getRuntime().data,
): Promise<Project> {
  const slug = await resolveUniqueSlug(slugify(input.slug ?? input.name), (s) =>
    store.projects.slugExists(input.orgId, s),
  );
  const { slug: _ignore, ...rest } = input;
  const project = await store.projects.create({ ...rest, slug });
  await store.environments.seedDefaults(project.id, DEFAULT_ENVIRONMENTS);
  return project;
}

/** Environments for a project, in creation order. */
export function listEnvironments(
  projectId: string,
  store: DataStore = getRuntime().data,
): Promise<Environment[]> {
  return store.environments.listByProject(projectId);
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
