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
  agents,
  deployments,
  draftChanges,
  environments,
  jobs,
  projects,
  releases,
} from "~/db/schema";

export type Agent = typeof agents.$inferSelect;
export type DraftChange = typeof draftChanges.$inferSelect;
export type Release = typeof releases.$inferSelect;
export type Deployment = typeof deployments.$inferSelect;
export type Environment = typeof environments.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type Job = typeof jobs.$inferSelect;

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
  /** A project's roster, by name. Single-agent repos are a team of one. */
  listByProject(projectId: string): Promise<Agent[]>;
  /**
   * Reconcile the roster with the repo's detected layout: upsert by (project, name) —
   * updating `root` when a member moved — and delete members no longer present.
   */
  syncRoster(
    projectId: string,
    roster: { name: string; root: string }[],
  ): Promise<Agent[]>;
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
  /** Seed named environments for a roster member (idempotent). */
  seedDefaults(projectId: string, agentId: string, names: readonly string[]): Promise<void>;
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
    repoOwner?: string | null;
    repoName?: string | null;
    repoInstallationId?: string | null;
    defaultBranch?: string;
  }): Promise<Project>;
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
    agentId: string;
    path: string;
    content: string;
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
/** A persisted chat transcript (assistant / playground) — one per (project, kind, user). */
export interface Conversation {
  id: string;
  projectId: string;
  kind: string;
  createdBy: string;
  /** Display transcript entries (shape owned by the surface). */
  messages: unknown[];
  /** Kind-specific continuation state (model history, eve session tokens). */
  state: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConversationRepo {
  get(projectId: string, kind: string, userId: string): Promise<Conversation | null>;
  /** Upsert the single conversation for (project, kind, user). */
  save(input: {
    projectId: string;
    kind: string;
    createdBy: string;
    messages: unknown[];
    state: Record<string, unknown>;
  }): Promise<Conversation>;
  delete(projectId: string, kind: string, userId: string): Promise<void>;
}

export interface DataStore {
  agents: AgentRepo;
  releases: ReleaseRepo;
  deployments: DeploymentRepo;
  environments: EnvironmentRepo;
  projects: ProjectRepo;
  jobs: JobRepo;
  drafts: DraftRepo;
  conversations: ConversationRepo;
  audit: AuditRepo;
}
