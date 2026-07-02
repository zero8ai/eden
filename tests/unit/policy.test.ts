import { describe, expect, it } from "vitest";

import { planFailure } from "~/jobs/policy";

const now = new Date("2026-07-02T00:00:00.000Z");

describe("planFailure", () => {
  it("requeues with linear backoff while attempts remain", () => {
    // First failure (attempts already incremented to 1 by the claim): 1 * 30s out.
    expect(planFailure({ attempts: 1, maxAttempts: 3 }, now)).toEqual({
      status: "queued",
      runAt: new Date(now.getTime() + 30_000),
    });
    // Second failure: 2 * 30s out.
    expect(planFailure({ attempts: 2, maxAttempts: 3 }, now)).toEqual({
      status: "queued",
      runAt: new Date(now.getTime() + 60_000),
    });
  });

  it("parks as failed once attempts reach maxAttempts", () => {
    expect(planFailure({ attempts: 3, maxAttempts: 3 }, now)).toEqual({ status: "failed" });
    expect(planFailure({ attempts: 2, maxAttempts: 2 }, now)).toEqual({ status: "failed" });
  });
});
