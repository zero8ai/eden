/**
 * Durable Postgres-backed job queue (control plane).
 *
 * Long-running work — builds and deploys above all — must not run inside HTTP request
 * handlers: GitHub delivers webhooks with a ~10s timeout while an `eve build` takes minutes,
 * and an in-request build dies silently on server restart. Handlers enqueue; the worker
 * (worker.server.ts) claims with FOR UPDATE SKIP LOCKED and executes. Jobs retry with linear
 * backoff up to `maxAttempts`, then land in `failed` for inspection.
 */
import { and, asc, eq, lte, sql } from "drizzle-orm";

import { db } from "~/db/client.server";
import { jobs } from "~/db/schema";

export type Job = typeof jobs.$inferSelect;

export type JobKind = "deploy_release" | "rollback_release";

export interface DeployReleasePayload {
  environmentId: string;
  releaseId: string;
  trafficWeight?: number;
  createdBy?: string | null;
  [key: string]: unknown;
}

/** Enqueue a job; returns its id. The worker picks it up on its next poll. */
export async function enqueue(
  kind: JobKind,
  payload: Record<string, unknown>,
  opts?: { runAt?: Date; maxAttempts?: number },
): Promise<string> {
  const [row] = await db
    .insert(jobs)
    .values({
      kind,
      payload,
      ...(opts?.runAt ? { runAt: opts.runAt } : {}),
      ...(opts?.maxAttempts ? { maxAttempts: opts.maxAttempts } : {}),
    })
    .returning({ id: jobs.id });
  return row.id;
}

/**
 * Atomically claim the next runnable job (queued, due). SKIP LOCKED makes concurrent
 * workers safe: each job is claimed by exactly one.
 */
export async function claimNext(): Promise<Job | null> {
  return db.transaction(async (tx) => {
    const [job] = await tx
      .select()
      .from(jobs)
      .where(and(eq(jobs.status, "queued"), lte(jobs.runAt, new Date())))
      .orderBy(asc(jobs.runAt))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!job) return null;
    await tx
      .update(jobs)
      .set({
        status: "running",
        attempts: job.attempts + 1,
        updatedAt: new Date(),
      })
      .where(eq(jobs.id, job.id));
    return { ...job, status: "running", attempts: job.attempts + 1 };
  });
}

export async function markDone(jobId: string): Promise<void> {
  await db
    .update(jobs)
    .set({ status: "done", error: null, updatedAt: new Date() })
    .where(eq(jobs.id, jobId));
}

/** Retry with linear backoff while attempts remain; park as `failed` after the last one. */
export async function markFailed(job: Job, error: string): Promise<void> {
  const retry = job.attempts < job.maxAttempts;
  await db
    .update(jobs)
    .set({
      status: retry ? "queued" : "failed",
      error,
      ...(retry ? { runAt: new Date(Date.now() + job.attempts * 30_000) } : {}),
      updatedAt: new Date(),
    })
    .where(eq(jobs.id, job.id));
}

/** Queue depth by status (ops/debug view). */
export async function queueStats(): Promise<Record<string, number>> {
  const rows = await db
    .select({ status: jobs.status, count: sql<number>`count(*)::int` })
    .from(jobs)
    .groupBy(jobs.status);
  return Object.fromEntries(rows.map((r) => [r.status, r.count]));
}
