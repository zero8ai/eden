/**
 * Data-access ports — the repository seam (PRD §8 style: depend on an interface, not on
 * Postgres). Control-plane logic (deploy controller, queue) talks to a `DataStore`, so it can
 * be unit-tested against an in-memory fake with no database, and the Drizzle implementation
 * (drizzle.server.ts) is the one place SQL lives. Interfaces are defined by consumer need, not
 * by mirroring the schema.
 *
 * Row types are the schema's inferred selects, so the fake and the real impl can't drift.
 */
import type {
  agentLinks,
  agents,
  delegations,
  deployments,
  draftChanges,
  environments,
  jobs,
  projects,
  releases,
  runs,
} from "~/db/schema";

export type Agent = typeof agents.$inferSelect;
export type DraftChange = typeof draftChanges.$inferSelect;
export type Release = typeof releases.$inferSelect;
export type Deployment = typeof deployments.$inferSelect;
export type Environment = typeof environments.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type AgentLink = typeof agentLinks.$inferSelect;
export type Delegation = typeof delegations.$inferSelect;
export type Run = typeof runs.$inferSelect;

/** A deployment row joined to its release's version/commit (the list/split view). */
export interface DeploymentWithRelease {
  id: string;
  status: string;
  trafficWeight: number;
  url: string | null;
  errorDetail: string | null;
  createdAt: Date;
  releaseId: string;
  version: string;
  gitSha: string;
}

export interface AgentRepo {
  findById(id: string): Promise<Agent | null>;
  /**
   * A project's FULL agent set (every `kind`), by name. Callers that want only the roster of
   * user-facing members must filter `kind === 'member'` (or use `listAgents`), but drafts /
   * `agentForPath` need the internal assistant row too, so this never filters.
   */
  listByProject(projectId: string): Promise<Agent[]>;
  /**
   * Reconcile the roster with the repo's detected layout: upsert by (project, name) —
   * updating `root` when a member moved — and delete members no longer present. Only rows with
   * `kind === 'member'` are pruned; internal rows (the assistant) are never in the detected
   * roster and survive every sync.
   */
  syncRoster(
    projectId: string,
    roster: { name: string; root: string }[],
    options?: { allowEmpty?: boolean },
  ): Promise<Agent[]>;
  /**
   * Rename a member IN PLACE — updates `name` (and `root`, which moves with the directory) while
   * preserving the row id, so every FK to it (environments, releases, secrets, drafts) survives.
   * The one safe primitive for a rename: a prune/recreate would cascade the member's history away.
   */
  rename(id: string, patch: { name: string; root: string }): Promise<Agent>;
  /** Set (or clear, with null) the pending-rename target for a member. */
  setPendingName(id: string, pendingName: string | null): Promise<void>;
  /** The project's built-in assistant row (`kind === 'assistant'`), or null. */
  findAssistant(projectId: string): Promise<Agent | null>;
  /** Create the built-in assistant row. Caller ensures single-instance via `findAssistant`. */
  createAssistant(input: {
    projectId: string;
    name: string;
    root: string;
  }): Promise<Agent>;
}

export interface ReleaseRepo {
  /** Existing releases for one agent (version numbering is per agent). */
  countByAgent(agentId: string): Promise<number>;
  /** A project's releases, newest first (version history). */
  listByProject(projectId: string): Promise<Release[]>;
  /** Insert a release; throws an (agent, version) unique-violation like Postgres would. */
  insert(input: {
    projectId: string;
    agentId: string;
    version: string;
    gitSha: string;
    changelog?: string | null;
    createdBy?: string | null;
  }): Promise<Release>;
  findById(id: string): Promise<Release | null>;
  findByCommit(agentId: string, gitSha: string): Promise<Release | null>;
  setImageRef(id: string, imageRef: string): Promise<void>;
}

export interface DeploymentRepo {
  findById(id: string): Promise<Deployment | null>;
  /**
   * Insert a deployment; a second in-flight (pending/building) row for the same environment
   * throws the `deployments_env_inflight_uq` unique-violation like Postgres would.
   */
  insert(input: {
    environmentId: string;
    releaseId: string;
    status: string;
    trafficWeight: number;
    createdBy?: string | null;
  }): Promise<Deployment>;
  update(
    id: string,
    patch: Partial<Pick<Deployment, "status" | "url" | "errorDetail" | "trafficWeight">>,
  ): Promise<Deployment>;
  listByEnvironment(environmentId: string): Promise<DeploymentWithRelease[]>;
  /** Set every currently-live deployment in the env to draining at weight 0 (rollback). */
  drainLive(environmentId: string): Promise<void>;
  /** Delete an environment's failed deployment rows (post-mortem clutter). */
  deleteFailed(environmentId: string): Promise<void>;
  /** Apply weights atomically, scoped to the environment (clamped ≥ 0 by the caller). */
  setWeights(
    environmentId: string,
    weights: { deploymentId: string; weight: number }[],
  ): Promise<void>;
}

export interface EnvironmentRepo {
  findById(id: string): Promise<Environment | null>;
  /** All environments across a project's roster (legacy views; per-agent is the norm). */
  listByProject(projectId: string): Promise<Environment[]>;
  listByAgent(agentId: string): Promise<Environment[]>;
  /**
   * Guarantee the ≥1-environment invariant: insert an env named "default" ONLY when the
   * member has none. Idempotent on re-sync — agents with environments (whatever their
   * names) are never touched, so user CRUD survives roster self-heals and webhooks.
   */
  ensureDefault(projectId: string, agentId: string): Promise<void>;
  /** Create a named environment; throws the (agent, name) unique violation on duplicates. */
  create(input: { projectId: string; agentId: string; name: string }): Promise<Environment>;
  /** Rename; throws the (agent, name) unique violation on duplicates. */
  rename(id: string, name: string): Promise<void>;
  /**
   * Delete, refusing to remove the member's LAST environment (the check and the delete are
   * one statement, so concurrent deletes can't drop an agent to zero). True = deleted.
   */
  deleteById(id: string): Promise<boolean>;
}

export interface ProjectRepo {
  findById(id: string): Promise<Project | null>;
  findByRepo(owner: string, repo: string): Promise<Project | null>;
  /** Tenant-scoped read: returns the project only if it belongs to `orgId` (D2). */
  getByOrg(orgId: string, id: string): Promise<Project | null>;
  /** A tenant's projects, newest first. */
  listByOrg(orgId: string): Promise<Project[]>;
  /** Does this org already have a project with this slug? (uniqueness within a tenant). */
  slugExists(orgId: string, slug: string): Promise<boolean>;
  create(input: {
    orgId: string;
    name: string;
    slug: string;
    layout?: "single" | "team";
    repoOwner?: string | null;
    repoName?: string | null;
    repoInstallationId?: string | null;
    defaultBranch?: string;
  }): Promise<Project>;
  /** Delete the project row — the FK cascade takes every dependent row with it (M5.8). */
  deleteById(id: string): Promise<void>;
}

export interface JobRepo {
  insert(input: {
    kind: string;
    payload: Record<string, unknown>;
    runAt?: Date;
    maxAttempts?: number;
  }): Promise<string>;
  /** Atomically claim the oldest due queued job (increment attempts → running). */
  claimNext(now: Date): Promise<Job | null>;
  update(
    id: string,
    patch: Partial<Pick<Job, "status" | "error" | "runAt">>,
  ): Promise<void>;
  /** Requeue jobs stranded in `running` (a process restart killed their worker mid-job). */
  requeueRunning(): Promise<number>;
  statsByStatus(): Promise<Record<string, number>>;
}

export interface DraftRepo {
  /** Stage (upsert) a draft: latest content per (project, path) wins. */
  upsert(input: {
    projectId: string;
    /** Owning roster member; null for project-shared files (root package.json). */
    agentId: string | null;
    path: string;
    /** Full file contents; null stages a DELETION of the path. */
    content: string | null;
    baseSha?: string | null;
    createdBy?: string | null;
  }): Promise<DraftChange>;
  get(projectId: string, path: string): Promise<DraftChange | null>;
  /** A project's staged drafts, oldest first (stable checkbox order in the UI). */
  listByProject(projectId: string): Promise<DraftChange[]>;
  /** Remove drafts by path (after publish, or an explicit discard). */
  deleteByPaths(projectId: string, paths: string[]): Promise<void>;
}

export interface AuditRepo {
  record(input: {
    orgId: string;
    actorUserId?: string | null;
    action: string;
    target?: string | null;
    meta?: Record<string, unknown>;
  }): Promise<void>;
}

/** The full data seam handed to control-plane logic. */
/**
 * Directed teammate-collaboration overrides (Team delegation — D4). Default-allow: an ABSENT
 * row means the ask is permitted, so the relay's authz check reads a single row (or its
 * absence). Only pairs the human has touched exist here.
 */
export interface AgentLinkRepo {
  /** Every override row for a project — the Settings matrix reads this. */
  listByProject(projectId: string): Promise<AgentLink[]>;
  /** The override for one directed edge, or null (null = default-allow). */
  get(fromAgentId: string, toAgentId: string): Promise<AgentLink | null>;
  /** Upsert one directed edge's enabled flag (the matrix toggle). */
  set(input: {
    projectId: string;
    fromAgentId: string;
    toAgentId: string;
    enabled: boolean;
  }): Promise<void>;
}

/** The cross-agent correlation record for teammate asks (Team delegation — D6). */
export interface DelegationRepo {
  insert(input: {
    projectId: string;
    fromAgentId: string;
    fromEnvironmentId: string | null;
    toAgentId: string;
    toEnvironmentId: string | null;
  }): Promise<Delegation>;
  /** Settle a delegation row once the peer turn finishes (or fails). */
  finalize(
    id: string,
    patch: {
      status: string;
      error?: string | null;
      externalSessionId?: string | null;
      runId?: string | null;
      finishedAt?: Date;
    },
  ): Promise<void>;
  /** Active (running, not stale) delegations on one directed edge — the per-edge cap. */
  countActiveEdge(fromAgentId: string, toAgentId: string, since: Date): Promise<number>;
  /** Active (running, not stale) delegations across a project — the project-wide cap. */
  countActiveProject(projectId: string, since: Date): Promise<number>;
}

export interface RunRepo {
  /**
   * Settle runs interrupted when one deployment is stopped or replaced. The status guard makes
   * this safe to call after a turn has already reported its own terminal result.
   */
  failRunningByDeployment(
    deploymentId: string,
    error: string,
    finishedAt?: Date,
  ): Promise<number>;
}

export interface DataStore {
  agents: AgentRepo;
  releases: ReleaseRepo;
  deployments: DeploymentRepo;
  environments: EnvironmentRepo;
  projects: ProjectRepo;
  jobs: JobRepo;
  drafts: DraftRepo;
  audit: AuditRepo;
  agentLinks: AgentLinkRepo;
  delegations: DelegationRepo;
  runs: RunRepo;
}
