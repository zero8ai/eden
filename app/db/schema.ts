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
 *
 * IDs: every PK we mint is `varchar("id", { length: 12 }).primaryKey().$defaultFn(newId)`
 * with `newId` from ~/lib/id (12-char [a-zA-Z] nanoid). orgs/users keep WorkOS-issued text
 * ids. Legacy UUID rows were rewritten to nanoids in a one-off dev-DB pass (2026-07-04).
 */
import { sql } from "drizzle-orm";

import { newId } from "~/lib/id";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  varchar,
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

/**
 * GitHub App installations known to a tenant (Connect pillar). Persisted the first time the
 * install redirect lands so revisiting /connect never asks to "install" again — the picker
 * renders straight from the stored installation. An org can hold several (multiple GitHub
 * orgs); rows are dropped when GitHub reports the installation gone.
 */
export const githubInstallations = pgTable(
  "github_installations",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    installationId: text("installation_id").notNull(),
    /** GitHub account (org/user login) the app is installed on, for display. */
    accountLogin: text("account_login"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("github_installations_org_install_uq").on(t.orgId, t.installationId)],
);

/** A project == one connected eve repo. */
export const projects = pgTable(
  "projects",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
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

/**
 * An agent — a member of a project's roster (PRD §7.9 / Milestone 5.5). A single-agent repo
 * is a team of one (`name: "agent"`, `root: "agent"`); a team repo has one row per
 * `agents/<member>/agent/` directory. Everything downstream (environments, releases, runs,
 * drafts, secrets) keys by agent, never by project — the hard-committed schema split.
 * `root` is the repo-relative agent directory the member's config lives under.
 */
export const agents = pgTable(
  "agents",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    projectId: varchar("project_id", { length: 12 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    root: text("root").notNull(),
    /**
     * Roster classification. `member` is a normal roster agent detected from the repo tree
     * (the default — every synced row). `assistant` is Eden's built-in, project-level authoring
     * agent: one per project, created lazily, NEVER detected from the tree, so it must be
     * exempt from the roster prune in `syncRoster` and filtered out of every roster-facing
     * surface (team cards, switcher, teammate delegation, secrets scoping). It still keys
     * environments/releases/deployments/drafts like any agent, which is how it reuses the
     * whole deploy substrate for free.
     */
    kind: text("kind").notNull().default("member"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("agents_project_name_uq").on(t.projectId, t.name)],
);

/** A deploy environment for an agent (e.g. production, staging). Per-agent by decision (§7.9). */
export const environments = pgTable(
  "environments",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    projectId: varchar("project_id", { length: 12 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    agentId: varchar("agent_id", { length: 12 })
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("environments_agent_name_uq").on(t.agentId, t.name)],
);

/**
 * An immutable Release (D9): a merge-commit + content-addressed image. `version` is the
 * human label (v1, v2). Never mutated after creation; rollback re-points a deployment.
 */
export const releases = pgTable(
  "releases",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    projectId: varchar("project_id", { length: 12 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    agentId: varchar("agent_id", { length: 12 })
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    version: text("version").notNull(),
    gitSha: text("git_sha").notNull(),
    imageRef: text("image_ref"),
    changelog: text("changelog"),
    createdBy: text("created_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("releases_agent_version_uq").on(t.agentId, t.version),
    index("releases_project_idx").on(t.projectId),
    index("releases_agent_idx").on(t.agentId),
  ],
);

/**
 * Binds a release to an environment. The PRODUCT model is one live deployment per environment
 * (M6): a deploy that lands live demotes the env's other live rows (cutover, controller-
 * enforced — no unique constraint, since a cutover transiently has two live rows). The DATA
 * model still admits multi-version-live behind a weighted, session-sticky splitter (D9/D10);
 * `trafficWeight` is a relative integer the ingress splitter normalizes across active rows.
 */
export const deployments = pgTable(
  "deployments",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    environmentId: varchar("environment_id", { length: 12 })
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    releaseId: varchar("release_id", { length: 12 })
      .notNull()
      .references(() => releases.id, { onDelete: "restrict" }),
    // pending | building | live | draining | stopped | failed
    status: text("status").notNull().default("pending"),
    trafficWeight: integer("traffic_weight").notNull().default(100),
    url: text("url"),
    /** Why the deployment failed (build/deploy error surface for the UI). */
    errorDetail: text("error_detail"),
    createdBy: text("created_by").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("deployments_environment_idx").on(t.environmentId)],
);

/**
 * Staged, unpublished edits — the product's "git staging area" (PRD §7.3: edits accumulate
 * per change-set; PUBLISHING opens the PR). One row per (project, path), latest content wins.
 * Saving an editor stages a draft here (no git write); the Changes tab lists drafts with
 * checkboxes and Publish turns the selected ones into one branch + one PR, then deletes them.
 * The repo stays the source of truth for published config — this table only ever holds
 * in-flight edits, and rows are short-lived.
 */
export const draftChanges = pgTable(
  "draft_changes",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    projectId: varchar("project_id", { length: 12 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /**
     * The roster member the path belongs to (derived from the path's agent root). Null for
     * project-shared files outside every member (e.g. the root package.json).
     */
    agentId: varchar("agent_id", { length: 12 }).references(() => agents.id, { onDelete: "cascade" }),
    /** Repo-relative path under the agent's root (e.g. "agent/instructions.md"). */
    path: text("path").notNull(),
    /**
     * Full new file contents (drafts are whole-file, like the editors). NULL stages a
     * DELETION of the path — deletes ride the same stage → publish/ship rails as edits
     * instead of opening their own change request on the spot.
     */
    content: text("content"),
    /** Blob sha of the file when the edit was made (null = new file); future conflict hints. */
    baseSha: text("base_sha"),
    createdBy: text("created_by").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("draft_changes_project_path_uq").on(t.projectId, t.path)],
);

/**
 * Secret METADATA only (D3 + SecretsProvider seam, HANDOFF §8): names/scope/audit, never
 * values. Values live in the SecretsProvider (local no-op for OSS, KMS/Vault for managed).
 */
export const secretsMetadata = pgTable(
  "secrets_metadata",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    projectId: varchar("project_id", { length: 12 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /**
     * Owning roster member, OR null for a PROJECT-LEVEL shared secret (defined once, attached to
     * members via `secret_attachments`). A concrete agentId scopes the secret to one member (PRD
     * §7.9 — teammates never share credentials by default); null is the opt-in shared surface.
     */
    agentId: varchar("agent_id", { length: 12 }).references(() => agents.id, {
      onDelete: "cascade",
    }),
    // null environmentId == agent-wide secret (all of that agent's environments)
    environmentId: varchar("environment_id", { length: 12 }).references(() => environments.id, {
      onDelete: "cascade",
    }),
    key: text("key").notNull(),
    /**
     * Expose this secret to the agent's SANDBOX shell (not just its tools). Deploys join the
     * exposed names into EDEN_SANDBOX_ENV — the allowlist the scaffolded sandbox.ts forwards
     * into the sandbox env (~/eve/templates). Metadata, not a value: it lives here (never in
     * the SecretsProvider) so exposure survives provider swaps and value rotations.
     * For SHARED secrets this is only the DEFAULT seeded into new attachments — the authoritative
     * per-member flag lives on `secret_attachments.sandboxExposed` (never retro-applied).
     */
    sandboxExposed: boolean("sandbox_exposed").notNull().default(false),
    /**
     * Full SHA-256 hex of the plaintext, computed server-side at write time (never the value).
     * Lets the UI show "fp a3f9c2" so a human can compare against a value they hold without ever
     * revealing the stored one. Null for rows written before fingerprints existed (backfill-free).
     */
    fingerprint: text("fingerprint"),
    updatedBy: text("updated_by").references(() => users.id),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("secrets_agent_scope_key_uq")
      .on(t.projectId, t.agentId, t.environmentId, t.key)
      .nullsNotDistinct(),
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
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    projectId: varchar("project_id", { length: 12 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** Roster member the run belongs to; nullable — telemetry may arrive unattributed. */
    agentId: varchar("agent_id", { length: 12 }).references(() => agents.id, { onDelete: "set null" }),
    deploymentId: varchar("deployment_id", { length: 12 }).references(() => deployments.id, {
      onDelete: "set null",
    }),
    releaseId: varchar("release_id", { length: 12 }).references(() => releases.id, {
      onDelete: "set null",
    }),
    sessionId: varchar("session_id", { length: 12 }),
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
    index("runs_agent_started_idx").on(t.agentId, t.startedAt),
    index("runs_release_idx").on(t.releaseId),
    uniqueIndex("runs_external_uq").on(t.projectId, t.externalRunId),
  ],
);

/**
 * Observability: a Session is a durable conversation/task; each triggering input creates a
 * Run (indexed in `runs`); a Run has ordered Steps. (PRD §7.6, ARCH §3.7.)
 */
export const sessions = pgTable(
  "sessions",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    projectId: varchar("project_id", { length: 12 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    agentId: varchar("agent_id", { length: 12 }).references(() => agents.id, { onDelete: "set null" }),
    externalSessionId: text("external_session_id"),
    trigger: text("trigger"),
    channel: text("channel"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("sessions_project_started_idx").on(t.projectId, t.startedAt),
    unique("sessions_external_uq")
      .on(t.projectId, t.externalSessionId)
      .nullsNotDistinct(),
  ],
);

/**
 * Ordered steps within a Run: model calls, tool calls, reasoning, messages. Common scalar
 * fields are columns for filtering; the full per-step payload (messages, args, output) is in
 * `data` (jsonb). The system prompt is reconstructed from the Run's Release commit, not stored.
 */
export const runSteps = pgTable(
  "run_steps",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    runId: varchar("run_id", { length: 12 })
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    // model_call | tool_call | reasoning | message
    type: text("type").notNull(),
    model: text("model"),
    toolName: text("tool_name"),
    tokensInput: integer("tokens_input"),
    tokensOutput: integer("tokens_output"),
    durationMs: integer("duration_ms"),
    isError: boolean("is_error").notNull().default(false),
    approvalGated: boolean("approval_gated").notNull().default(false),
    data: jsonb("data").$type<Record<string, unknown>>().default(sql`'{}'::jsonb`),
    startedAt: timestamp("started_at", { withTimezone: true }),
  },
  (t) => [index("run_steps_run_seq_idx").on(t.runId, t.seq)],
);

/**
 * Per-project ingest tokens for the authenticated OTLP/runs endpoint (ARCH §3.7). BYO
 * instances ship telemetry back with one of these Bearer tokens. Only the hash is stored.
 */
export const ingestTokens = pgTable(
  "ingest_tokens",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    projectId: varchar("project_id", { length: 12 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: createdAt(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => [index("ingest_tokens_project_idx").on(t.projectId)],
);

/**
 * Encrypted secret VALUES for the OSS local SecretsProvider. Managed uses KMS/Vault instead
 * (same seam), so this table is only populated by the local provider. Values are AES-256-GCM
 * encrypted with `EDEN_SECRETS_KEY`; we store ciphertext + iv + auth tag, never plaintext.
 * `secrets_metadata` remains the name/audit index; this is the value store behind the seam.
 */
export const secretValues = pgTable(
  "secret_values",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    projectId: varchar("project_id", { length: 12 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** Owning member, OR null for a project-level shared secret (mirrors secrets_metadata). */
    agentId: varchar("agent_id", { length: 12 }).references(() => agents.id, {
      onDelete: "cascade",
    }),
    environmentId: varchar("environment_id", { length: 12 }).references(() => environments.id, {
      onDelete: "cascade",
    }),
    key: text("key").notNull(),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    authTag: text("auth_tag").notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("secret_values_agent_scope_key_uq")
      .on(t.projectId, t.agentId, t.environmentId, t.key)
      .nullsNotDistinct(),
  ],
);

/**
 * Per-agent opt-in to a project-level SHARED secret (§4.3). Attachment is BY NAME — it covers
 * every env row of the shared secret with that key. `sandboxExposed` is the AUTHORITATIVE
 * sandbox flag for the shared secret on this member (seeded from the shared default at attach
 * time, never retro-applied). A concrete agent-level secret with the same name shadows the
 * attachment at resolve (precedence, §5); the attachment row simply lies dormant.
 */
export const secretAttachments = pgTable(
  "secret_attachments",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    projectId: varchar("project_id", { length: 12 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    agentId: varchar("agent_id", { length: 12 })
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    sandboxExposed: boolean("sandbox_exposed").notNull().default(false),
    createdBy: text("created_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("secret_attachments_agent_key_uq").on(t.agentId, t.key)],
);

/**
 * A dismissed template requirement (§7): the human marked a required-but-unset secret as "not
 * needed" for this member, so it stops surfacing as a missing-required row and stops gating the
 * deploy guard. Recoverable (never a hard delete of anything) — removing the row restores the
 * requirement. Implementer's choice per §7 (a small table over a JSON column: isolated, cascades
 * cleanly, and doesn't widen the widely-typed `agents` row).
 */
export const secretRequirementDismissals = pgTable(
  "secret_requirement_dismissals",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    projectId: varchar("project_id", { length: 12 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    agentId: varchar("agent_id", { length: 12 })
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    createdBy: text("created_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("secret_req_dismissals_agent_key_uq").on(t.agentId, t.key)],
);

/**
 * Sealed secret values HELD for a new-member install (§4.4). An agent template installs as a new
 * roster member whose `agents` row doesn't exist until the change ships, so the wizard can't key
 * the secret to an agent yet. It stashes the sealed value here (same secretbox as `secret_values`),
 * keyed by the roster NAME the install will create; the value migrates into
 * `secret_values`/`secrets_metadata` the moment that member's agent row appears (syncRoster), and
 * is discarded if the install/draft is abandoned. Never surfaced to a client.
 */
export const pendingSecrets = pgTable(
  "pending_secrets",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    projectId: varchar("project_id", { length: 12 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** The roster member name the install will create (agents/<name>/…). */
    memberName: text("member_name").notNull(),
    key: text("key").notNull(),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    authTag: text("auth_tag").notNull(),
    /** SHA-256 hex of the held plaintext — carried into secrets_metadata at ship (§4.1). */
    fingerprint: text("fingerprint"),
    sandboxExposed: boolean("sandbox_exposed").notNull().default(false),
    /** Set when the wizard recorded "use the project-level shared secret" instead of a value. */
    attachShared: boolean("attach_shared").notNull().default(false),
    createdBy: text("created_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("pending_secrets_scope_key_uq").on(t.projectId, t.memberName, t.key),
  ],
);

/**
 * Registered schedules for the Scheduler seam. OSS persists them for visibility; managed's
 * scheduler reads this to wake scaled-to-zero instances at cron time (ARCH §3.3).
 */
export const schedules = pgTable(
  "schedules",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    deploymentId: varchar("deployment_id", { length: 12 })
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    cron: text("cron").notNull(),
    name: text("name"),
    createdAt: createdAt(),
  },
  (t) => [index("schedules_deployment_idx").on(t.deploymentId)],
);

/**
 * Per-tenant spend controls (managed mode — ARCH §3.2/§3.4/§8). The model gateway checks these
 * before allowing a turn: a monthly token cap and a kill-switch. OSS leaves rows absent
 * (unlimited). Keyed by WorkOS org id.
 */
export const spendLimits = pgTable("spend_limits", {
  orgId: text("org_id")
    .primaryKey()
    .references(() => orgs.id, { onDelete: "cascade" }),
  monthlyTokenCap: integer("monthly_token_cap"),
  killSwitch: boolean("kill_switch").notNull().default(false),
  updatedAt: updatedAt(),
});

/**
 * Operational audit log (ARCH §3.8) — deploys, rollbacks, secret changes, spend-limit edits.
 * This is the audit of *operations*; identity/auth audit is delegated to WorkOS. Keyed by org.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    target: text("target"),
    meta: jsonb("meta").$type<Record<string, unknown>>().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [index("audit_log_org_created_idx").on(t.orgId, t.createdAt)],
);

/**
 * Raw usage events (MeteringSink seam). OSS records them locally for visibility; managed
 * aggregates and pushes Stripe usage records (ARCH §3.4). Kept append-only.
 */
export const usageEvents = pgTable(
  "usage_events",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    deploymentId: varchar("deployment_id", { length: 12 }).references(() => deployments.id, {
      onDelete: "set null",
    }),
    // model_tokens | compute_seconds | sandbox_exec
    kind: text("kind").notNull(),
    quantity: integer("quantity").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    meta: jsonb("meta").$type<Record<string, unknown>>().default(sql`'{}'::jsonb`),
  },
  (t) => [index("usage_events_org_at_idx").on(t.orgId, t.at)],
);

/**
 * Durable background jobs (control-plane work queue). Builds/deploys run here, not in HTTP
 * request handlers: GitHub webhooks time out at ~10s while an `eve build` takes minutes, and
 * a queued job survives a server restart. Claimed with FOR UPDATE SKIP LOCKED (single-worker
 * semantics per job, N workers safe).
 */
export const jobs = pgTable(
  "jobs",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    // e.g. deploy_release
    kind: text("kind").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    // queued | running | done | failed
    status: text("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    /** Earliest time the job may run (backoff on retry). */
    runAt: timestamp("run_at", { withTimezone: true }).defaultNow().notNull(),
    error: text("error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("jobs_status_run_at_idx").on(t.status, t.runAt)],
);

/**
 * Workspace-level OpenRouter settings: encrypted key plus the default model id inherited by
 * the authoring assistant and agents with no local model.
 */
export const workspaceSettings = pgTable("workspace_settings", {
  orgId: text("org_id")
    .primaryKey()
    .references(() => orgs.id, { onDelete: "cascade" }),
  modelKeyCiphertext: text("model_key_ciphertext"),
  modelKeyIv: text("model_key_iv"),
  modelKeyAuthTag: text("model_key_auth_tag"),
  /** Workspace default OpenRouter model id (null = Eden's default). */
  assistantModel: text("assistant_model"),
  updatedAt: updatedAt(),
});

/**
 * Eden's index of Eve playground sessions. The transcript itself lives in Eve's durable
 * event stream; this table stores the app-owned thread/cursor needed to list and resume
 * sessions for a project/agent/user.
 */
export const playgroundSessions = pgTable(
  "playground_sessions",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    projectId: varchar("project_id", { length: 12 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    agentId: varchar("agent_id", { length: 12 })
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    environmentId: varchar("environment_id", { length: 12 }).references(() => environments.id, {
      onDelete: "cascade",
    }),
    /** Same value passed to DeployRequest.worldKey; currently the environment id. */
    worldKey: text("world_key"),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Eve runtime-owned stream/inspect handle. */
    externalSessionId: text("external_session_id"),
    /** Eve channel-owned resume handle. */
    continuationToken: text("continuation_token"),
    /** Number of Eve stream events consumed from the durable event stream. */
    streamIndex: integer("stream_index").notNull().default(0),
    title: text("title"),
    /** new | running | waiting | completed | failed */
    status: text("status").notNull().default("new"),
    lastDeploymentId: varchar("last_deployment_id", { length: 12 }).references(
      () => deployments.id,
      { onDelete: "set null" },
    ),
    lastReleaseId: varchar("last_release_id", { length: 12 }).references(() => releases.id, {
      onDelete: "set null",
    }),
    lastVersion: text("last_version"),
    lastEventAt: timestamp("last_event_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("playground_sessions_scope_updated_idx").on(
      t.projectId,
      t.agentId,
      t.createdBy,
      t.updatedAt,
    ),
    uniqueIndex("playground_sessions_external_uq").on(t.projectId, t.externalSessionId),
  ],
);

/**
 * Assistant coding-agent checkouts (docs/ASSISTANT.md — coding-agent model). One row per
 * assistant conversation (a `playground_sessions` row on the assistant channel) that has grown a
 * repo checkout. The assistant edits a per-conversation git checkout on the shared home volume;
 * after each turn the control plane mirrors that checkout onto the branch `eden/conv-<id>` and
 * (on first non-empty sync) opens a PR. This table is the only durable link from a conversation to
 * its branch/PR — the checkout itself is ephemeral (volume/instance loss is recovered by re-cloning
 * the remote branch). `lastSyncedHash` lets the sync engine skip a no-op turn (tree unchanged).
 */
export const assistantCheckouts = pgTable(
  "assistant_checkouts",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    /** The conversation == the assistant `playground_sessions` row (1:1). */
    conversationId: varchar("conversation_id", { length: 12 })
      .notNull()
      .references(() => playgroundSessions.id, { onDelete: "cascade" }),
    projectId: varchar("project_id", { length: 12 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** Working branch the conversation's checkout is mirrored onto (`eden/conv-<id>`). */
    branch: text("branch").notNull(),
    /** Base branch the working branch is cut from (the project default at first sync). */
    baseBranch: text("base_branch").notNull(),
    /** Open PR number for the branch, or null before the first non-empty sync. */
    prNumber: integer("pr_number"),
    /** Whether the open PR is still a draft/WIP (false once marked ready-for-review). */
    prDraft: boolean("pr_draft").notNull().default(true),
    /** Content hash of the last mirrored tree state — a matching hash means "skip, no change". */
    lastSyncedHash: text("last_synced_hash"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("assistant_checkouts_conversation_uq").on(t.conversationId)],
);

/**
 * Directed teammate-collaboration overrides (Team delegation, PRD §7.9 runtime half — D4).
 * A row exists ONLY for a (from → to) pair the human has touched; an ABSENT row means the ask
 * is allowed (default-allow). This avoids seeding on roster sync, avoids a backfill migration,
 * and never resurrects a deleted override when a member self-heals — new members collaborate
 * immediately. `enabled=false` is the one thing this table records: a pair the human turned off.
 * The relay checks it live on every ask, so a toggle takes effect with no redeploy.
 */
export const agentLinks = pgTable(
  "agent_links",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    projectId: varchar("project_id", { length: 12 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    fromAgentId: varchar("from_agent_id", { length: 12 })
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    toAgentId: varchar("to_agent_id", { length: 12 })
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("agent_links_pair_uq").on(t.fromAgentId, t.toAgentId)],
);

/**
 * One row per teammate ask — the cross-agent correlation record (Team delegation — D6). The
 * relay writes it `running` before it forwards the message and finalizes it (completed|failed)
 * once the peer's turn settles, recording the peer eve session, the peer's Eden run row, and
 * timing. Concurrency caps count `running` rows younger than (timeout + slack), so a crashed
 * relay can never wedge the caps. Agent FKs `set null` on member removal — the correlation
 * record survives the roster change that outlived it.
 */
export const delegations = pgTable(
  "delegations",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    projectId: varchar("project_id", { length: 12 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    fromAgentId: varchar("from_agent_id", { length: 12 }).references(() => agents.id, {
      onDelete: "set null",
    }),
    fromEnvironmentId: varchar("from_environment_id", { length: 12 }),
    toAgentId: varchar("to_agent_id", { length: 12 }).references(() => agents.id, {
      onDelete: "set null",
    }),
    toEnvironmentId: varchar("to_environment_id", { length: 12 }),
    /** The peer eve session the relay opened for this ask. */
    externalSessionId: text("external_session_id"),
    /** The peer's Eden run row (runs.id), for linked traces. */
    runId: varchar("run_id", { length: 12 }),
    // running | completed | failed
    status: text("status").notNull().default("running"),
    error: text("error"),
    startedAt: createdAt(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("delegations_project_started_idx").on(t.projectId, t.startedAt)],
);
