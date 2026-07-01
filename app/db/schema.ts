/**
 * Eden control-plane schema (Drizzle + Postgres).
 *
 * Scope rules (see HANDOFF.md §2 / PRD):
 *  - D2: a WorkOS Organization == an Eden tenant. `orgs`/`users` are keyed by WorkOS IDs
 *    (text), and we delegate roles/SSO/directory-sync to WorkOS. We keep only a thin mirror
 *    so we can foreign-key our own rows and cache display fields.
 *  - D3: the eve repo is the single source of truth. We DO NOT store agent config here —
 *    only pointers (repo coordinates, git SHAs, image refs) and operational state.
 *  - D9: a Release = an immutable merge-commit + content-addressed image. Deployments bind a
 *    release to an environment with a traffic weight for the multi-version splitter (D9/D10).
 */
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).defaultNow().notNull();

/** Tenant. `id` is the WorkOS Organization id (e.g. "org_..."). */
export const orgs = pgTable("orgs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: createdAt(),
});

/** `id` is the WorkOS User id (e.g. "user_..."). Mirror for FKs + display. */
export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  name: text("name"),
  createdAt: createdAt(),
});

/**
 * A user's membership in an org. WorkOS is authoritative for roles; `role` is a cached
 * copy for fast authorization checks in loaders without a WorkOS round-trip.
 */
export const memberships = pgTable(
  "memberships",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId] })],
);

/** A project == one connected eve repo. */
export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    // GitHub coordinates (Connect pillar, M0). installationId ties to the GitHub App install.
    repoOwner: text("repo_owner"),
    repoName: text("repo_name"),
    repoInstallationId: text("repo_installation_id"),
    defaultBranch: text("default_branch").notNull().default("main"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("projects_org_slug_uq").on(t.orgId, t.slug)],
);

/** A deploy environment for a project (e.g. production, staging). */
export const environments = pgTable(
  "environments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("environments_project_name_uq").on(t.projectId, t.name)],
);

/**
 * An immutable Release (D9): a merge-commit + content-addressed image. `version` is the
 * human label (v1, v2). Never mutated after creation; rollback re-points a deployment.
 */
export const releases = pgTable(
  "releases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    version: text("version").notNull(),
    gitSha: text("git_sha").notNull(),
    imageRef: text("image_ref"),
    changelog: text("changelog"),
    createdBy: text("created_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("releases_project_version_uq").on(t.projectId, t.version),
    index("releases_project_idx").on(t.projectId),
  ],
);

/**
 * Binds a release to an environment. Multiple active deployments per environment enable
 * multi-version-live behind a weighted, session-sticky splitter (D9/D10). `trafficWeight`
 * is a relative integer weight; the ingress splitter normalizes across active rows.
 */
export const deployments = pgTable(
  "deployments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    releaseId: uuid("release_id")
      .notNull()
      .references(() => releases.id, { onDelete: "restrict" }),
    // pending | building | live | draining | stopped | failed
    status: text("status").notNull().default("pending"),
    trafficWeight: integer("traffic_weight").notNull().default(100),
    url: text("url"),
    createdBy: text("created_by").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("deployments_environment_idx").on(t.environmentId)],
);

/**
 * Secret METADATA only (D3 + SecretsProvider seam, HANDOFF §8): names/scope/audit, never
 * values. Values live in the SecretsProvider (local no-op for OSS, KMS/Vault for managed).
 */
export const secretsMetadata = pgTable(
  "secrets_metadata",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // null environmentId == project-wide secret
    environmentId: uuid("environment_id").references(() => environments.id, {
      onDelete: "cascade",
    }),
    key: text("key").notNull(),
    updatedBy: text("updated_by").references(() => users.id),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("secrets_scope_key_uq").on(
      t.projectId,
      t.environmentId,
      t.key,
    ),
  ],
);

/**
 * Observability index (D8). One row per agent run; heavy transcript/span data lives in the
 * runs store / OTLP sink (TelemetrySink seam). This table is the queryable index for the
 * Run list + compare-by-version views.
 */
export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    deploymentId: uuid("deployment_id").references(() => deployments.id, {
      onDelete: "set null",
    }),
    releaseId: uuid("release_id").references(() => releases.id, {
      onDelete: "set null",
    }),
    // Correlates to the eve/Workflow run id in the telemetry store.
    externalRunId: text("external_run_id"),
    channel: text("channel"),
    // running | completed | failed
    status: text("status").notNull().default("running"),
    tokensInput: integer("tokens_input"),
    tokensOutput: integer("tokens_output"),
    wallClockMs: integer("wall_clock_ms"),
    error: text("error"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default(sql`'{}'::jsonb`),
    startedAt: timestamp("started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("runs_project_started_idx").on(t.projectId, t.startedAt),
    index("runs_release_idx").on(t.releaseId),
    uniqueIndex("runs_external_uq").on(t.projectId, t.externalRunId),
  ],
);
