/**
 * Pure job-retry policy. The queue's persistence (claim/update) lives behind the data seam;
 * the *decision* — retry with backoff while attempts remain, else park as failed — is here so
 * it can be unit-tested without a database or clock.
 */

export interface RetryablJob {
  attempts: number;
  maxAttempts: number;
}

export interface FailurePlan {
  status: "queued" | "failed";
  /** Set only when retrying: earliest time the job may run again. */
  runAt?: Date;
}

/**
 * Decide what happens to a job that just failed its current attempt. Linear backoff
 * (`attempts * 30s`) while attempts remain; terminal `failed` after the last one. `now` is
 * injected so the backoff target is deterministic in tests.
 */
export function planFailure(job: RetryablJob, now: Date): FailurePlan {
  if (job.attempts < job.maxAttempts) {
    return { status: "queued", runAt: new Date(now.getTime() + job.attempts * 30_000) };
  }
  return { status: "failed" };
}
