/**
 * Deploy controller orchestration — against in-memory fakes (no DB, no docker). Verifies the
 * logic the controller owns: version labelling + collision retry, release idempotency, the
 * build→deploy→record pipeline (success and failure), rollback draining, and scoped splits.
 * Row-locking / real constraint enforcement is the store impl's job (trusted at schema level).
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  createRelease,
  deployRelease,
  ensureReleaseForCommit,
  listDeployments,
  queueDeploy,
  rollbackTo,
  setTrafficSplit,
} from "~/deploy/controller.server";
import { fakeDeployTarget, fakeSecrets } from "../fakes/infra";
import { makeFakeStore, type FakeStore } from "../fakes/store";

let store: FakeStore;
const PROJECT = "proj_1";
const ORG = "org_1";
const ENV = "env_1";

beforeEach(() => {
  store = makeFakeStore();
  store.seedProject({ id: PROJECT, orgId: ORG, repoOwner: "acme", repoName: "agent" });
  store.seedEnvironment({ id: ENV, projectId: PROJECT, name: "production" });
});

describe("createRelease", () => {
  it("labels releases v1, v2, … per project", async () => {
    const r1 = await createRelease({ projectId: PROJECT, gitSha: "a".repeat(40) }, store);
    const r2 = await createRelease({ projectId: PROJECT, gitSha: "b".repeat(40) }, store);
    expect(r1.version).toBe("v1");
    expect(r2.version).toBe("v2");
  });

  it("retries past a version-label collision and still lands", async () => {
    store.forceReleaseCollisions(2); // first two inserts raise 23505, third succeeds
    const r = await createRelease({ projectId: PROJECT, gitSha: "c".repeat(40) }, store);
    expect(r.version).toBe("v1");
  });
});

describe("ensureReleaseForCommit", () => {
  it("is idempotent per merge commit (in-app merge + webhook converge)", async () => {
    const sha = "d".repeat(40);
    const first = await ensureReleaseForCommit({ projectId: PROJECT, gitSha: sha }, store);
    const second = await ensureReleaseForCommit({ projectId: PROJECT, gitSha: sha }, store);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.release.id).toBe(first.release.id);
  });
});

describe("deployRelease", () => {
  it("builds, deploys live, records the image + an audit entry", async () => {
    const release = await createRelease({ projectId: PROJECT, gitSha: "e".repeat(40) }, store);
    const dep = await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      { store, deployTarget: fakeDeployTarget({ health: { status: "live", url: "http://x" } }), secrets: fakeSecrets() },
    );
    expect(dep.status).toBe("live");
    expect(dep.url).toBe("http://x");
    expect((await store.releases.findById(release.id))?.imageRef).toBe("img:fake");
    expect(store.auditEntries).toContainEqual({ action: "deploy", target: "v1", orgId: ORG });
  });

  it("inherits the workspace OpenRouter key unless a secret overrides it (PRD §12)", async () => {
    const release = await createRelease({ projectId: PROJECT, gitSha: "a1".repeat(20) }, store);
    const deployedEnvs: Record<string, string>[] = [];
    const base = {
      store,
      deployTarget: fakeDeployTarget({ health: { status: "live" as const }, deployedEnvs }),
      workspaceModelKey: async () => "sk-or-workspace",
    };

    // No project secret → the workspace key is injected.
    await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      { ...base, secrets: fakeSecrets() },
    );
    expect(deployedEnvs[0].OPENROUTER_API_KEY).toBe("sk-or-workspace");

    // A project/environment secret with the same name wins.
    await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      { ...base, secrets: fakeSecrets({ OPENROUTER_API_KEY: "sk-or-project" }) },
    );
    expect(deployedEnvs[1].OPENROUTER_API_KEY).toBe("sk-or-project");
  });

  it("records failed status WITH the reason when the target throws", async () => {
    const release = await createRelease({ projectId: PROJECT, gitSha: "f".repeat(40) }, store);
    const dep = await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      { store, deployTarget: fakeDeployTarget({ deployError: "docker unavailable" }), secrets: fakeSecrets() },
    );
    expect(dep.status).toBe("failed");
    expect(dep.errorDetail).toBe("docker unavailable");
  });
});

describe("queueDeploy", () => {
  it("creates the queued row FIRST, and the job takes over that same row (no duplicate)", async () => {
    const release = await createRelease({ projectId: PROJECT, gitSha: "9".repeat(40) }, store);

    // Click: row exists immediately in `queued` — this is the UI's instant feedback.
    const queued = await queueDeploy(
      { environmentId: ENV, releaseId: release.id, createdBy: "user_1" },
      store,
    );
    expect(queued.status).toBe("queued");
    expect((await listDeployments(ENV, store)).map((d) => d.id)).toEqual([queued.id]);

    // Worker: claims the job, whose payload points at the pre-created row.
    const job = await store.jobs.claimNext(new Date());
    expect(job?.kind).toBe("deploy_release");
    expect(job?.payload.deploymentId).toBe(queued.id);

    // Executing the deploy updates that row — never inserts a second one.
    const done = await deployRelease(
      job!.payload as { environmentId: string; releaseId: string; deploymentId: string },
      { store, deployTarget: fakeDeployTarget({ health: { status: "live", url: "http://z" } }), secrets: fakeSecrets() },
    );
    expect(done.id).toBe(queued.id);
    expect(done.status).toBe("live");
    expect(await listDeployments(ENV, store)).toHaveLength(1);
  });
});

describe("redeploying the same release", () => {
  it("supersedes the previous live instance (stopped, weight 0) — never two live copies", async () => {
    const release = await createRelease({ projectId: PROJECT, gitSha: "8".repeat(40) }, store);
    const deps = {
      store,
      deployTarget: fakeDeployTarget({ health: { status: "live", url: "http://a" } }),
      secrets: fakeSecrets(),
    };
    const first = await deployRelease({ environmentId: ENV, releaseId: release.id }, deps);
    expect(first.status).toBe("live");

    const second = await deployRelease({ environmentId: ENV, releaseId: release.id }, deps);
    expect(second.status).toBe("live");

    const all = await listDeployments(ENV, store);
    const oldRow = all.find((d) => d.id === first.id);
    expect(oldRow?.status).toBe("stopped");
    expect(oldRow?.trafficWeight).toBe(0);
    // Exactly one live copy of the release remains.
    expect(all.filter((d) => d.status === "live")).toHaveLength(1);
  });
});

describe("rollbackTo", () => {
  it("drains live deployments and redeploys the prior release at 100", async () => {
    const rA = await createRelease({ projectId: PROJECT, gitSha: "1".repeat(40) }, store);
    const deps = { store, deployTarget: fakeDeployTarget({ health: { status: "live", url: "http://a" } }), secrets: fakeSecrets() };
    const depA = await deployRelease({ environmentId: ENV, releaseId: rA.id }, deps);
    expect(depA.status).toBe("live");

    const rolled = await rollbackTo({ environmentId: ENV, releaseId: rA.id }, deps);
    expect(rolled.trafficWeight).toBe(100);

    const all = await listDeployments(ENV, store);
    const drained = all.find((d) => d.id === depA.id);
    expect(drained?.status).toBe("draining");
    expect(drained?.trafficWeight).toBe(0);
  });
});

describe("setTrafficSplit", () => {
  it("applies weights within the environment and clamps negatives to 0", async () => {
    const release = await createRelease({ projectId: PROJECT, gitSha: "2".repeat(40) }, store);
    const deps = { store, deployTarget: fakeDeployTarget({ health: { status: "live", url: "http://y" } }), secrets: fakeSecrets() };
    const d1 = await deployRelease({ environmentId: ENV, releaseId: release.id }, deps);
    const d2 = await deployRelease({ environmentId: ENV, releaseId: release.id }, deps);

    await setTrafficSplit(ENV, [
      { deploymentId: d1.id, weight: 90 },
      { deploymentId: d2.id, weight: 10 },
    ], store);
    let all = await listDeployments(ENV, store);
    expect(all.find((d) => d.id === d1.id)?.trafficWeight).toBe(90);
    expect(all.find((d) => d.id === d2.id)?.trafficWeight).toBe(10);

    await setTrafficSplit(ENV, [{ deploymentId: d2.id, weight: -5 }], store);
    all = await listDeployments(ENV, store);
    expect(all.find((d) => d.id === d2.id)?.trafficWeight).toBe(0);
  });
});
