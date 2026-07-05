/**
 * The seams that keep OSS == managed (PRD §8, ARCH §1.5).
 *
 * Every capability that differs between the open-source/self-host build and the commercial
 * managed service hides behind one of these interfaces. OSS ships local/no-op/BYO
 * implementations; managed ships the real ones (KMS, model-gateway proxy, Stripe, Nomad).
 * There is no fork — `getRuntime()` (index.server.ts) selects implementations by `EDEN_MODE`.
 *
 * Pure types only (no server imports) so they can be referenced anywhere.
 */
import type {
  CatalogIndex,
  TemplateManifest,
  TemplateType,
} from "~/marketplace/manifest";
import type { DataStore } from "~/data/ports";

export type EdenMode = "oss" | "managed";

// ── DeployTarget ────────────────────────────────────────────────────────────
// Build/provision/deploy/health for a running eve instance. OSS: ContainerPostgres (BYO).
// Managed: BareMetalDocker/Nomad. (PRD §7.4, ARCH §3.1.)

export interface BuildRequest {
  projectId: string;
  repo: { owner: string; repo: string };
  /** Git commit SHA to build (the merge commit for a Release). */
  ref: string;
  /** GitHub App installation that can read the repo (targets that fetch source need it). */
  installationId?: string | null;
  /**
   * Repo-relative directory of the eve project to build. "agent" (repo root project) for
   * single-agent repos; "agents/<member>/agent" for a team member (PRD §7.9) — the build
   * runs in the member's package directory (the root's parent for team members).
   */
  agentRoot?: string;
}

export interface BuiltArtifact {
  /** Image reference, e.g. registry/host:tag. */
  imageRef: string;
  /** Content-addressed digest (sha256:…) — the immutable half of a Release identity. */
  digest: string;
  logs?: string;
}

export interface DeployRequest {
  deploymentId: string;
  imageRef: string;
  /** Secrets + config injected as container env at start. */
  env: Record<string, string>;
  /**
   * Stable per-environment key for the instance's Workflow world database. Every deployment
   * of an environment shares one world, so eve sessions AND their durable sandbox containers
   * (the filesystems behind /workspace) survive a redeploy — eve's intended "sessions survive
   * cold starts, redeploys, and long pauses" semantics.
   */
  worldKey: string;
}

/** Compile-check request: repo@ref with the staged drafts overlaid (publish gate). */
export interface BuildCheckRequest {
  projectId: string;
  repo: { owner: string; repo: string };
  /** Ref to base the check on — the default branch the change request targets. */
  ref: string;
  installationId?: string | null;
  /** Draft files being published, overlaid on the source before building. Null content
   * removes the file — the gate checks the tree as it will exist after the change merges. */
  overlay: { path: string; content: string | null }[];
  /** Agent directory to check when all drafts belong to one member (team repos, §7.9). */
  agentRoot?: string;
}

export type BuildCheckResult =
  /** Build compiles (or the target has no toolchain and the gate was skipped). */
  | { ok: true; skipped?: boolean }
  /** Build failed — `output` is the compiler/tool error, human-readable. */
  | { ok: false; output: string };

export type InstanceStatus =
  | "pending"
  | "building"
  | "starting"
  | "live"
  | "stopped"
  | "failed";

export interface InstanceHealth {
  status: InstanceStatus;
  url?: string;
  detail?: string;
}

export interface DeployTarget {
  readonly name: string;
  build(req: BuildRequest): Promise<BuiltArtifact>;
  /**
   * Compile-check source + overlay without deploying — the publish gate that keeps a
   * change request from being created for code that can't build. Optional: targets
   * without a local toolchain simply skip the gate.
   */
  checkBuild?(req: BuildCheckRequest): Promise<BuildCheckResult>;
  deploy(req: DeployRequest): Promise<InstanceHealth>;
  /** Scale-to-zero: stop an idle instance (0 CPU/RAM); state survives in Postgres. */
  stop(deploymentId: string): Promise<void>;
  /** Wake a stopped instance. */
  start(deploymentId: string): Promise<InstanceHealth>;
  health(deploymentId: string): Promise<InstanceHealth>;
  /**
   * Permanently tear an instance down (environment delete): stop AND remove the container.
   * Optional — targets without it fall back to `stop`, leaving state for manual cleanup.
   * Per-deployment `destroy` no longer drops the shared world state (see `destroyWorld`):
   * many deployments of one environment share a world, so a single deployment's teardown
   * must not orphan its siblings' sessions.
   */
  destroy?(deploymentId: string): Promise<void>;
  /**
   * Drop an environment's shared Workflow world database. Called on environment/repository
   * teardown AFTER the per-deployment `destroy` loop — the last step, once no deployment of
   * the environment survives to need its sessions. Optional. (`worldKey` is `DeployRequest.worldKey`.)
   */
  destroyWorld?(worldKey: string): Promise<void>;
}

// ── SecretsProvider ─────────────────────────────────────────────────────────
// Encrypted per-environment secrets; never written to the repo. OSS: local encrypted
// store. Managed: KMS/Vault. (PRD §7.2, ARCH §3.5.)

/** A secret scope: per-agent by decision (PRD §7.9) — teammates never share credentials. */
export interface SecretScope {
  projectId: string;
  agentId: string;
  /** null == agent-wide (all of that agent's environments). */
  environmentId: string | null;
}

export interface SecretRef extends SecretScope {
  key: string;
}

export interface SecretsProvider {
  readonly name: string;
  set(ref: SecretRef, value: string): Promise<void>;
  get(ref: SecretRef): Promise<string | null>;
  delete(ref: SecretRef): Promise<void>;
  /** Secret names in scope (values never listed). */
  listNames(scope: SecretScope): Promise<string[]>;
  /** name → value map for deploy-time env injection (agent-wide, overridden by env-scoped). */
  resolve(scope: SecretScope): Promise<Record<string, string>>;
}

// ── ModelGateway ────────────────────────────────────────────────────────────
// Where instances send model calls. OSS: direct provider keys. Managed: our proxy that
// owns keys, meters tokens, and enforces spend caps. (ARCH §3.2.)

export interface ModelEndpoint {
  baseUrl: string;
  headers: Record<string, string>;
}

export interface BudgetDecision {
  allowed: boolean;
  reason?: string;
}

export interface ModelGateway {
  readonly name: string;
  /** Base URL + auth headers an instance should use for model calls. */
  endpointFor(instanceId: string): Promise<ModelEndpoint>;
  /** Spend-cap / kill-switch check for a tenant before allowing a turn. */
  checkBudget(orgId: string): Promise<BudgetDecision>;
}

// ── MeteringSink ────────────────────────────────────────────────────────────
// Usage capture. OSS: no-op (or local usage table). Managed: usage events → Stripe.
// (PRD §7.5, ARCH §3.4.)

export type MeterKind = "model_tokens" | "compute_seconds" | "sandbox_exec";

export interface MeterEvent {
  orgId: string;
  deploymentId?: string;
  kind: MeterKind;
  quantity: number;
  /** ISO timestamp; caller stamps it (workflow-safe). */
  at: string;
  meta?: Record<string, unknown>;
}

export interface MeteringSink {
  readonly name: string;
  record(event: MeterEvent): Promise<void>;
}

// ── Scheduler ───────────────────────────────────────────────────────────────
// Fires crons; in managed it WAKES scaled-to-zero instances. OSS: local/no-op (eve's own
// schedules run in-instance). (ARCH §3.3.)

export interface ScheduleSpec {
  id: string;
  deploymentId: string;
  /** Standard cron expression. */
  cron: string;
  name?: string;
}

export interface Scheduler {
  readonly name: string;
  register(spec: ScheduleSpec): Promise<void>;
  unregister(id: string): Promise<void>;
  list(deploymentId: string): Promise<ScheduleSpec[]>;
}

// ── TelemetrySink ───────────────────────────────────────────────────────────
// Ingest side of run-observability. OSS: local (co-located). BYO/managed: authenticated
// OTLP receiver. Normalizes into the runs store. (PRD §7.6, ARCH §3.7.)

export interface TelemetrySink {
  readonly name: string;
  /** Accept a normalized run/step payload from an instance and persist it. */
  ingest(payload: NormalizedRunEvent): Promise<void>;
}

/** Minimal normalized shape the ingest endpoint maps OTLP/event-log into. */
export interface NormalizedRunEvent {
  projectId: string;
  deploymentId?: string;
  releaseId?: string;
  externalRunId: string;
  channel?: string;
  status?: "running" | "completed" | "failed";
  tokensInput?: number;
  tokensOutput?: number;
  wallClockMs?: number;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  metadata?: Record<string, unknown>;
}

// ── CatalogSource ─────────────────────────────────────────────────────────────
// The marketplace catalog (PRD §7.8, Milestone 6). OSS: fixture-backed by the in-repo
// `marketplace/` seed for dev/tests, or a GitHub raw pointer at the eve OSS repo's
// `marketplace/`. The seam keeps browse independent of where the catalog physically lives.

/** A fully-loaded template: its manifest plus every declared file's content, keyed by path. */
export interface CatalogTemplate {
  manifest: TemplateManifest;
  /** install-relative path → file content (exactly the manifest's `files` set). */
  files: Record<string, string>;
}

export interface CatalogSource {
  readonly name: string;
  /** The browse index — the light projection Eden lists from (never the file bodies). */
  index(): Promise<CatalogIndex>;
  /** One template with its files loaded, for the detail page (and, phase 2, install). */
  template(type: TemplateType, id: string): Promise<CatalogTemplate>;
}

/** The full set of runtime implementations selected for the current mode. */
export interface EdenRuntime {
  mode: EdenMode;
  data: DataStore;
  deployTarget: DeployTarget;
  secrets: SecretsProvider;
  modelGateway: ModelGateway;
  metering: MeteringSink;
  scheduler: Scheduler;
  telemetry: TelemetrySink;
  catalog: CatalogSource;
}
