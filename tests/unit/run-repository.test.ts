import { describe, expect, it } from "vitest";

import { makeFakeStore } from "../fakes/store";

describe("run repository fake", () => {
  it("fails only running runs for the deployment and clamps negative durations", async () => {
    const store = makeFakeStore();
    const finishedAt = new Date("2026-07-11T05:00:00.000Z");
    store.seedRun({
      id: "run_target",
      projectId: "project_1",
      deploymentId: "deployment_1",
      startedAt: new Date("2026-07-11T04:59:55.000Z"),
    });
    store.seedRun({
      id: "run_skewed",
      projectId: "project_1",
      deploymentId: "deployment_1",
      startedAt: new Date("2026-07-11T05:00:01.000Z"),
    });
    store.seedRun({
      id: "run_stale",
      projectId: "project_1",
      deploymentId: "deployment_1",
      startedAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    store.seedRun({
      id: "run_settled",
      projectId: "project_1",
      deploymentId: "deployment_1",
      status: "completed",
      wallClockMs: 123,
      finishedAt: new Date("2026-07-11T04:59:59.000Z"),
    });
    store.seedRun({
      id: "run_other",
      projectId: "project_1",
      deploymentId: "deployment_2",
    });

    await expect(
      store.runs.failRunningByDeployment(
        "deployment_1",
        "interrupted by redeploy",
        finishedAt,
      ),
    ).resolves.toBe(3);

    expect(store.getRun("run_target")).toMatchObject({
      status: "failed",
      error: "interrupted by redeploy",
      finishedAt,
      wallClockMs: 5_000,
    });
    expect(store.getRun("run_skewed")?.wallClockMs).toBe(0);
    expect(store.getRun("run_stale")?.wallClockMs).toBe(2_147_483_647);
    expect(store.getRun("run_settled")).toMatchObject({
      status: "completed",
      error: null,
      wallClockMs: 123,
      finishedAt: new Date("2026-07-11T04:59:59.000Z"),
    });
    expect(store.getRun("run_other")?.status).toBe("running");
    await expect(
      store.runs.failRunningByDeployment(
        "deployment_1",
        "interrupted by redeploy",
        finishedAt,
      ),
    ).resolves.toBe(0);
  });
});
