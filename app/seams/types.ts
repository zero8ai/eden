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
}

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
  deploy(req: DeployRequest): Promise<InstanceHealth>;
  /** Scale-to-zero: stop an idle instance (0 CPU/RAM); state survives in Postgres. */
  stop(deploymentId: string): Promise<void>;
  /** Wake a stopped instance. */
  start(deploymentId: string): Promise<InstanceHealth>;
  health(deploymentId: string): Promise<InstanceHealth>;
}

// ── SecretsProvider ─────────────────────────────────────────────────────────
// Encrypted per-environment secrets; never written to the repo. OSS: local encrypted
// store. Managed: KMS/Vault. (PRD §7.2, ARCH §3.5.)

export interface SecretRef {
  projectId: string;
  /** null == project-wide (all environments). */
  environmentId: string | null;
  key: string;
}

export interface SecretsProvider {
  readonly name: string;
  set(ref: SecretRef, value: string): Promise<void>;
  get(ref: SecretRef): Promise<string | null>;
  delete(ref: SecretRef): Promise<void>;
  /** Secret names in scope (values never listed). */
  listNames(projectId: string, environmentId: string | null): Promise<string[]>;
  /** name → value map for deploy-time env injection. */
  resolve(
    projectId: string,
    environmentId: string | null,
  ): Promise<Record<string, string>>;
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

/** The full set of runtime implementations selected for the current mode. */
export interface EdenRuntime {
  mode: EdenMode;
  deployTarget: DeployTarget;
  secrets: SecretsProvider;
  modelGateway: ModelGateway;
  metering: MeteringSink;
  scheduler: Scheduler;
  telemetry: TelemetrySink;
}
