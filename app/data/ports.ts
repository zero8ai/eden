/**
 * Data-access ports — the repository seam (PRD §8 style: depend on an interface, not on
 * Postgres). Control-plane logic (deploy controller, queue) talks to a `DataStore`, so it can
 * be unit-tested against an in-memory fake with no database, and the Drizzle implementation
 * (drizzle.server.ts) is the one place SQL lives. Interfaces are defined by consumer need, not
 * by mirroring the schema.
 *
 * Row types are the schema's inferred selects, so the fake and the real impl can't drift.
 */
import type { deployments, environments, jobs, projects, releases } from "~/db/schema";

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

export interface ReleaseRepo {
  countByProject(projectId: string): Promise<number>;
  /** Insert a release; throws a (project, version) unique-violation like Postgres would. */
  insert(input: {
    projectId: string;
    version: string;
    gitSha: string;
    changelog?: string | null;
    createdBy?: string | null;
  }): Promise<Release>;
  findById(id: string): Promise<Release | null>;
  findByCommit(projectId: string, gitSha: string): Promise<Release | null>;
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
  /** Apply weights atomically, scoped to the environment (clamped ≥ 0 by the caller). */
  setWeights(
    environmentId: string,
    weights: { deploymentId: string; weight: number }[],
  ): Promise<void>;
}

export interface EnvironmentRepo {
  findById(id: string): Promise<Environment | null>;
}

export interface ProjectRepo {
  findById(id: string): Promise<Project | null>;
  findByRepo(owner: string, repo: string): Promise<Project | null>;
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
  statsByStatus(): Promise<Record<string, number>>;
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
export interface DataStore {
  releases: ReleaseRepo;
  deployments: DeploymentRepo;
  environments: EnvironmentRepo;
  projects: ProjectRepo;
  jobs: JobRepo;
  audit: AuditRepo;
}
