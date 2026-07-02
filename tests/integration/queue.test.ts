/**
 * Job queue semantics: exclusive claims, backoff-retry, and terminal failure after
 * maxAttempts. (The worker loop itself is exercised in dev; these pin the queue contract.)
 */
import { beforeAll, describe, expect, it } from "vitest";

import { db } from "~/db/client.server";
import { jobs } from "~/db/schema";
import { claimNext, enqueue, markDone, markFailed } from "~/jobs/queue.server";

beforeAll(async () => {
  // These assertions reason about "the only claimable job" — start from an empty queue.
  await db.delete(jobs);
});

describe("job queue", () => {
  it("claims a queued job exactly once", async () => {
    await enqueue("deploy_release", { marker: "claim-once" });
    const first = await claimNext();
    expect(first?.status).toBe("running");
    expect(first?.attempts).toBe(1);
    // Nothing else is due — the just-claimed job is running, not queued.
    expect(await claimNext()).toBeNull();
    await markDone(first!.id);
  });

  it("requeues with future runAt while attempts remain, then parks as failed", async () => {
    await enqueue("deploy_release", { marker: "retry" }, { maxAttempts: 2 });
    const attempt1 = await claimNext();
    await markFailed(attempt1!, "boom");
    // Backed off into the future — not claimable right now.
    expect(await claimNext()).toBeNull();

    // Simulate the backoff elapsing.
    const { db } = await import("~/db/client.server");
    const { jobs } = await import("~/db/schema");
    const { eq } = await import("drizzle-orm");
    await db
      .update(jobs)
      .set({ runAt: new Date(Date.now() - 1000) })
      .where(eq(jobs.id, attempt1!.id));

    const attempt2 = await claimNext();
    expect(attempt2?.id).toBe(attempt1!.id);
    expect(attempt2?.attempts).toBe(2);
    await markFailed(attempt2!, "boom again");

    const [row] = await db.select().from(jobs).where(eq(jobs.id, attempt1!.id));
    expect(row.status).toBe("failed");
    expect(row.error).toBe("boom again");
  });
});
