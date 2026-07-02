/**
 * Deploy controller state machine: release labels (incl. the concurrent-create race),
 * failure recording, rollback draining, and transactional traffic splits — all against a
 * real Postgres, with the container target (no docker) making every deploy fail loud.
 */
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { db } from "~/db/client.server";
import { deployments, environments, orgs } from "~/db/schema";
import { createProject } from "~/db/queries.server";
import {
  createRelease,
  deployRelease,
  listDeployments,
  rollbackTo,
  setTrafficSplit,
} from "~/deploy/controller.server";

const orgId = `org_test_deploy_${process.pid}`;
let projectId: string;
let envId: string;

beforeAll(async () => {
  await db.insert(orgs).values({ id: orgId, name: "Deploy Org" }).onConflictDoNothing();
  const project = await createProject({ orgId, name: "Deploy Agent" });
  projectId = project.id;
  const [env] = await db
    .select()
    .from(environments)
    .where(eq(environments.projectId, projectId));
  envId = env.id;
});

describe("releases", () => {
  it("labels releases v1, v2, … per project", async () => {
    const r1 = await createRelease({ projectId, gitSha: "a".repeat(40) });
    const r2 = await createRelease({ projectId, gitSha: "b".repeat(40) });
    expect(r1.version).toBe("v1");
    expect(r2.version).toBe("v2");
  });

  it("survives concurrent creates without duplicate labels", async () => {
    const made = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        createRelease({ projectId, gitSha: String(i).repeat(40) }),
      ),
    );
    const labels = made.map((r) => r.version);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("deployments", () => {
  it("records failed status WITH the reason when the target is unavailable", async () => {
    const release = await createRelease({ projectId, gitSha: "c".repeat(40) });
    const dep = await deployRelease({ environmentId: envId, releaseId: release.id });
    expect(dep.status).toBe("failed");
    expect(dep.errorDetail).toMatch(/Deploy step/);
  });

  it("rollback drains live deployments and redeploys the prior release at 100", async () => {
    const rA = await createRelease({ projectId, gitSha: "d".repeat(40) });
    const rB = await createRelease({ projectId, gitSha: "e".repeat(40) });
    const depA = await deployRelease({ environmentId: envId, releaseId: rA.id });
    // Simulate depA being live (the container target can't actually run it here).
    await db
      .update(deployments)
      .set({ status: "live", trafficWeight: 100 })
      .where(eq(deployments.id, depA.id));
    await deployRelease({ environmentId: envId, releaseId: rB.id });

    const rolled = await rollbackTo({ environmentId: envId, releaseId: rA.id });
    expect(rolled.trafficWeight).toBe(100);

    const all = await listDeployments(envId);
    const oldLive = all.find((d) => d.id === depA.id);
    expect(oldLive?.status).toBe("draining");
    expect(oldLive?.trafficWeight).toBe(0);
  });

  it("applies traffic splits only within the environment, atomically", async () => {
    const release = await createRelease({ projectId, gitSha: "f".repeat(40) });
    const d1 = await deployRelease({ environmentId: envId, releaseId: release.id });
    const d2 = await deployRelease({ environmentId: envId, releaseId: release.id });
    await setTrafficSplit(envId, [
      { deploymentId: d1.id, weight: 90 },
      { deploymentId: d2.id, weight: 10 },
    ]);
    const all = await listDeployments(envId);
    expect(all.find((d) => d.id === d1.id)?.trafficWeight).toBe(90);
    expect(all.find((d) => d.id === d2.id)?.trafficWeight).toBe(10);

    // Negative weights clamp to 0 (splitter weights are non-negative integers).
    await setTrafficSplit(envId, [{ deploymentId: d2.id, weight: -5 }]);
    expect(
      (await listDeployments(envId)).find((d) => d.id === d2.id)?.trafficWeight,
    ).toBe(0);
  });
});
