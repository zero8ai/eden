/**
 * Queue wiring over the DataStore fake (no DB). The retry/backoff *math* is covered by
 * policy.test.ts; this pins how enqueue/claim/markDone/markFailed compose with the store —
 * claim-once, mark done, and the retry-then-park transition. Real SKIP-LOCKED exclusion is the
 * Drizzle impl's job (trusted at schema level).
 */
import { beforeEach, describe, expect, it } from "vitest";

import { claimNext, enqueue, markDone, markFailed, queueStats } from "~/jobs/queue.server";
import { makeFakeStore, type FakeStore } from "../fakes/store";

let store: FakeStore;

beforeEach(() => {
  store = makeFakeStore();
});

describe("queue", () => {
  it("claims a due job once, then marks it done", async () => {
    await enqueue("deploy_release", { marker: "x" }, undefined, store);
    const first = await claimNext(store);
    expect(first?.status).toBe("running");
    expect(first?.attempts).toBe(1);
    expect(await claimNext(store)).toBeNull(); // nothing else due; the claimed one is running

    await markDone(first!.id, store);
    expect(await queueStats(store)).toEqual({ done: 1 });
  });

  it("requeues with a future runAt while attempts remain, then parks as failed", async () => {
    await enqueue("deploy_release", { marker: "retry" }, { maxAttempts: 2 }, store);

    const attempt1 = await claimNext(store);
    await markFailed(attempt1!, "boom", store);
    // Backed off into the future — not claimable right now.
    expect(await claimNext(store)).toBeNull();

    // Simulate the backoff elapsing, then reclaim.
    await store.jobs.update(attempt1!.id, { runAt: new Date(0) });
    const attempt2 = await claimNext(store);
    expect(attempt2?.id).toBe(attempt1!.id);
    expect(attempt2?.attempts).toBe(2);

    await markFailed(attempt2!, "boom again", store);
    expect(await queueStats(store)).toEqual({ failed: 1 });
  });
});
