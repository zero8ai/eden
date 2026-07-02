/**
 * In-process job worker. Polls the queue and executes handlers; started once per server
 * process via ensureWorkerStarted() (HMR/multi-import safe through a globalThis guard, same
 * pattern as the db client). For v1 the worker lives inside the web process — one box, one
 * process (ARCH §2); it moves to a dedicated process/container by just importing and calling
 * startWorker() elsewhere. Concurrency 1: builds are docker-bound and serializing them keeps
 * resource use predictable on a dev box.
 */
import { deployRelease, rollbackTo } from "~/deploy/controller.server";
import type { DeployReleasePayload, Job } from "./queue.server";
import { claimNext, markDone, markFailed } from "./queue.server";

const POLL_MS = Number(process.env.EDEN_WORKER_POLL_MS ?? 2000);

async function execute(job: Job): Promise<void> {
  switch (job.kind) {
    case "deploy_release":
    case "rollback_release": {
      const p = job.payload as DeployReleasePayload;
      const dep =
        job.kind === "deploy_release" ? await deployRelease(p) : await rollbackTo(p);
      // A deployment that records `failed` is a real outcome, not a queue error — but
      // surfacing it as a job failure gets retries for transient build/docker flakes.
      if (dep.status === "failed") {
        throw new Error(dep.errorDetail ?? "deployment failed");
      }
      return;
    }
    default:
      throw new Error(`Unknown job kind: ${job.kind}`);
  }
}

async function tick(): Promise<void> {
  // Drain everything due, one job at a time; sleep only when the queue is empty.
  for (;;) {
    let job: Job | null = null;
    try {
      job = await claimNext();
    } catch (err) {
      console.error("[jobs] claim failed:", err);
      return;
    }
    if (!job) return;
    try {
      await execute(job);
      await markDone(job.id);
      console.log(`[jobs] done ${job.kind} ${job.id}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[jobs] ${job.kind} ${job.id} attempt ${job.attempts} failed: ${msg}`);
      await markFailed(job, msg);
    }
  }
}

function startWorker(): { stop: () => void } {
  let running = false;
  const interval = setInterval(async () => {
    if (running) return; // don't stack ticks behind a long build
    running = true;
    try {
      await tick();
    } finally {
      running = false;
    }
  }, POLL_MS);
  interval.unref?.();
  console.log(`[jobs] worker started (poll ${POLL_MS}ms)`);
  return { stop: () => clearInterval(interval) };
}

const globalForWorker = globalThis as unknown as {
  __edenJobWorker?: { stop: () => void };
};

/** Start the worker once per process; safe to call from any server module. */
export function ensureWorkerStarted(): void {
  if (process.env.EDEN_DISABLE_WORKER === "1") return;
  globalForWorker.__edenJobWorker ??= startWorker();
}
