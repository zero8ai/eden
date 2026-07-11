import { describe, expect, it } from "vitest";

import { shouldSettleAbandonedSession } from "~/playground/settle";

const IDLE = 5 * 60_000;

const base = {
  status: "running",
  activeTurnInProcess: false,
  ownerDeploymentLive: true,
  msSinceLastActivity: 0,
  idleTimeoutMs: IDLE,
};

describe("shouldSettleAbandonedSession", () => {
  it("settles a running session whose owning deployment is gone (redeploy killed the turn)", () => {
    expect(
      shouldSettleAbandonedSession({ ...base, ownerDeploymentLive: false }),
    ).toBe(true);
  });

  it("settles a running session silent past the drain's idle budget even if the deployment is live", () => {
    expect(
      shouldSettleAbandonedSession({ ...base, msSinceLastActivity: IDLE + 1 }),
    ).toBe(true);
  });

  it("leaves a running session alone while its drain is streaming in this process", () => {
    // Even with the owner gone: the drain owns the turn's fate and will settle it itself when
    // its stream to the dead instance breaks.
    expect(
      shouldSettleAbandonedSession({
        ...base,
        activeTurnInProcess: true,
        ownerDeploymentLive: false,
      }),
    ).toBe(false);
  });

  it("leaves a recently-active running session on a live deployment (drain elsewhere, e.g. another replica)", () => {
    expect(
      shouldSettleAbandonedSession({ ...base, msSinceLastActivity: 30_000 }),
    ).toBe(false);
  });

  it("never settles sessions that aren't running", () => {
    for (const status of ["waiting", "completed", "failed", "stopped"]) {
      expect(
        shouldSettleAbandonedSession({
          ...base,
          status,
          ownerDeploymentLive: false,
          msSinceLastActivity: IDLE * 10,
        }),
      ).toBe(false);
    }
  });
});
