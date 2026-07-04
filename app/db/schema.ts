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
 * IDs: existing tables keep their uuid defaults (no migration); NEW tables take
 * `text("id").primaryKey().$defaultFn(newId)` with `newId` from ~/lib/id — see that module.
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
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    root: text("root").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("agents_project_name_uq").on(t.projectId, t.name)],
);

/** A deploy environment for an agent (e.g. production, staging). Per-agent by decision (§7.9). */
export const environments = pgTable(
  "environments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
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
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
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
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** The roster member the path belongs to (derived from the path's agent root). */
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /** Repo-relative path under the agent's root (e.g. "agent/instructions.md"). */
    path: text("path").notNull(),
    /** Full new file contents (drafts are whole-file, like the editors). */
    content: text("content").notNull(),
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
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** Per-agent scope (PRD §7.9 decision): a teammate never sees another's credentials. */
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    // null environmentId == agent-wide secret (all of that agent's environments)
    environmentId: uuid("environment_id").references(() => environments.id, {
      onDelete: "cascade",
    }),
    key: text("key").notNull(),
    updatedBy: text("updated_by").references(() => users.id),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("secrets_agent_scope_key_uq")
      .on(t.agentId, t.environmentId, t.key)
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
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** Roster member the run belongs to; nullable — telemetry may arrive unattributed. */
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    deploymentId: uuid("deployment_id").references(() => deployments.id, {
      onDelete: "set null",
    }),
    releaseId: uuid("release_id").references(() => releases.id, {
      onDelete: "set null",
    }),
    sessionId: uuid("session_id"),
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
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
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
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
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
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
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
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    environmentId: uuid("environment_id").references(() => environments.id, {
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
      .on(t.agentId, t.environmentId, t.key)
      .nullsNotDistinct(),
  ],
);

/**
 * Registered schedules for the Scheduler seam. OSS persists them for visibility; managed's
 * scheduler reads this to wake scaled-to-zero instances at cron time (ARCH §3.3).
 */
export const schedules = pgTable(
  "schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deploymentId: uuid("deployment_id")
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
    id: uuid("id").primaryKey().defaultRandom(),
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
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    deploymentId: uuid("deployment_id").references(() => deployments.id, {
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
    id: uuid("id").primaryKey().defaultRandom(),
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
 * Workspace-level model provider key (PRD §12 resolution): one OpenRouter key per org that
 * every deploy inherits as OPENROUTER_API_KEY unless a project/environment secret overrides
 * it, and that the authoring assistant uses. Sealed with the same AES-GCM box as secrets.
 */
export const workspaceSettings = pgTable("workspace_settings", {
  orgId: text("org_id")
    .primaryKey()
    .references(() => orgs.id, { onDelete: "cascade" }),
  modelKeyCiphertext: text("model_key_ciphertext"),
  modelKeyIv: text("model_key_iv"),
  modelKeyAuthTag: text("model_key_auth_tag"),
  /** OpenRouter model id the authoring assistant uses (null = Eden's default). */
  assistantModel: text("assistant_model"),
  updatedAt: updatedAt(),
});

/**
 * Persistent chat transcripts for Eden's conversational surfaces (assistant, playground).
 * Exactly ONE active conversation per (project, kind, user) — no session management; it
 * survives navigation and expires after idle (see chat/conversation.server.ts). `messages`
 * is the display transcript; `state` is kind-specific continuation state (the assistant's
 * model-message history / the playground's eve session tokens).
 */
export const conversations = pgTable(
  "conversations",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** assistant | playground */
    kind: text("kind").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    messages: jsonb("messages").$type<unknown[]>().notNull().default([]),
    state: jsonb("state").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("conversations_scope_uq").on(t.projectId, t.kind, t.createdBy)],
);
