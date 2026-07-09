/**
 * Deploy controller orchestration — against in-memory fakes (no DB, no docker). Verifies the
 * logic the controller owns: version labelling + collision retry, release idempotency, the
 * build→deploy→record pipeline (success and failure), single-live cutover, rollback, and
 * scoped splits.
 * Row-locking / real constraint enforcement is the store impl's job (trusted at schema level).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createRelease,
  deployRelease,
  ensureReleaseForCommit,
  listDeployments,
  queueDeploy,
  rollbackTo,
  setTrafficSplit,
} from "~/deploy/controller.server";
import {
  cleanupDeploymentContainer,
  DEPLOYMENT_CONTAINER_CLEANUP_GRACE_MS,
} from "~/deploy/cleanup.server";
import type { DeployTarget } from "~/seams/types";
import { fakeDeployTarget, fakeSecrets } from "../fakes/infra";
import { makeFakeStore, type FakeStore } from "../fakes/store";

// Team-delegation roster reads go through the cached GitHub source — stub it so the controller
// can build EDEN_TEAMMATES without network. (Only the team-injection tests exercise this.)
vi.mock("~/github/cached.server", () => ({
  getAgentSource: vi.fn(async () => ({
    paths: [],
    files: {
      "agents/deployer/agent/instructions.md":
        "# Deployer\n\nDeploys builds to production.",
    },
    ref: "main",
    truncated: false,
  })),
}));

let store: FakeStore;
const PROJECT = "proj_1";
const ORG = "org_1";
const AGENT = "agent_1";
const ENV = "env_1";

beforeEach(() => {
  store = makeFakeStore();
  store.seedProject({
    id: PROJECT,
    orgId: ORG,
    repoOwner: "acme",
    repoName: "agent",
  });
  store.seedAgent({ id: AGENT, projectId: PROJECT });
  store.seedEnvironment({
    id: ENV,
    projectId: PROJECT,
    agentId: AGENT,
    name: "production",
  });
});

describe("createRelease", () => {
  it("labels releases v1, v2, … per agent", async () => {
    const r1 = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "a".repeat(40) },
      store,
    );
    const r2 = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "b".repeat(40) },
      store,
    );
    expect(r1.version).toBe("v1");
    expect(r2.version).toBe("v2");
  });

  it("retries past a version-label collision and still lands", async () => {
    store.forceReleaseCollisions(2); // first two inserts raise 23505, third succeeds
    const r = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "c".repeat(40) },
      store,
    );
    expect(r.version).toBe("v1");
  });
});

describe("ensureReleaseForCommit", () => {
  it("is idempotent per merge commit (in-app merge + webhook converge)", async () => {
    const sha = "d".repeat(40);
    const first = await ensureReleaseForCommit(
      { projectId: PROJECT, agentId: AGENT, gitSha: sha },
      store,
    );
    const second = await ensureReleaseForCommit(
      { projectId: PROJECT, agentId: AGENT, gitSha: sha },
      store,
    );
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.release.id).toBe(first.release.id);
  });
});

describe("deployRelease", () => {
  it("builds, deploys live, records the image + an audit entry", async () => {
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "e".repeat(40) },
      store,
    );
    const dep = await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      {
        store,
        deployTarget: fakeDeployTarget({
          health: { status: "live", url: "http://x" },
        }),
        secrets: fakeSecrets(),
      },
    );
    expect(dep.status).toBe("live");
    expect(dep.url).toBe("http://x");
    expect((await store.releases.findById(release.id))?.imageRef).toBe(
      "img:fake",
    );
    expect(store.auditEntries).toContainEqual({
      action: "deploy",
      target: "v1",
      orgId: ORG,
    });
  });

  it("inherits the workspace OpenRouter key unless a secret overrides it (PRD §12)", async () => {
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "a1".repeat(20) },
      store,
    );
    const deployedEnvs: Record<string, string>[] = [];
    const base = {
      store,
      deployTarget: fakeDeployTarget({
        health: { status: "live" as const },
        deployedEnvs,
      }),
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
      {
        ...base,
        secrets: fakeSecrets({ OPENROUTER_API_KEY: "sk-or-project" }),
      },
    );
    expect(deployedEnvs[1].OPENROUTER_API_KEY).toBe("sk-or-project");
  });

  it("fails before deploy with a clear setup message when no model key is configured", async () => {
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "b2".repeat(20) },
      store,
    );
    const builtRefs: string[] = [];
    const deployedEnvs: Record<string, string>[] = [];

    const dep = await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      {
        store,
        deployTarget: fakeDeployTarget({ builtRefs, deployedEnvs }),
        secrets: fakeSecrets(),
        workspaceModelKey: async () => null,
      },
    );

    expect(dep.status).toBe("failed");
    expect(dep.errorDetail).toContain("No model provider key configured");
    expect(builtRefs).toEqual([]);
    expect(deployedEnvs).toEqual([]);
  });

  it("inherits local AI Gateway credentials unless a scoped secret overrides them", async () => {
    const oldGateway = process.env.AI_GATEWAY_API_KEY;
    const oldOidc = process.env.VERCEL_OIDC_TOKEN;
    process.env.AI_GATEWAY_API_KEY = "aigw-local";
    process.env.VERCEL_OIDC_TOKEN = "oidc-local";

    try {
      const release = await createRelease(
        { projectId: PROJECT, agentId: AGENT, gitSha: "c3".repeat(20) },
        store,
      );
      const deployedEnvs: Record<string, string>[] = [];
      const base = {
        store,
        deployTarget: fakeDeployTarget({
          health: { status: "live" as const },
          deployedEnvs,
        }),
      };

      await deployRelease(
        { environmentId: ENV, releaseId: release.id },
        { ...base, secrets: fakeSecrets() },
      );
      expect(deployedEnvs[0].AI_GATEWAY_API_KEY).toBe("aigw-local");
      expect(deployedEnvs[0].VERCEL_OIDC_TOKEN).toBe("oidc-local");

      await deployRelease(
        { environmentId: ENV, releaseId: release.id },
        {
          ...base,
          secrets: fakeSecrets({
            AI_GATEWAY_API_KEY: "aigw-secret",
            VERCEL_OIDC_TOKEN: "oidc-secret",
          }),
        },
      );
      expect(deployedEnvs[1].AI_GATEWAY_API_KEY).toBe("aigw-secret");
      expect(deployedEnvs[1].VERCEL_OIDC_TOKEN).toBe("oidc-secret");
    } finally {
      if (oldGateway === undefined) delete process.env.AI_GATEWAY_API_KEY;
      else process.env.AI_GATEWAY_API_KEY = oldGateway;
      if (oldOidc === undefined) delete process.env.VERCEL_OIDC_TOKEN;
      else process.env.VERCEL_OIDC_TOKEN = oldOidc;
    }
  });

  it("joins sandbox-exposed secret names into EDEN_SANDBOX_ENV (names only, after the spread)", async () => {
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "c3".repeat(20) },
      store,
    );
    const deployedEnvs: Record<string, string>[] = [];
    const base = {
      store,
      deployTarget: fakeDeployTarget({
        health: { status: "live" as const },
        deployedEnvs,
      }),
    };

    // Exposed + resolved → the allowlist carries exactly those names.
    await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      {
        ...base,
        secrets: fakeSecrets({
          GH_TOKEN: "gho_x",
          NPM_TOKEN: "npm_y",
          PRIVATE: "keep-out",
        }),
        sandboxExposedNames: async () => ["GH_TOKEN", "NPM_TOKEN"],
      },
    );
    expect(deployedEnvs[0].EDEN_SANDBOX_ENV).toBe("GH_TOKEN,NPM_TOKEN");
    expect(deployedEnvs[0].PRIVATE).toBe("keep-out"); // still injected — just not allowlisted

    // Exposure of a name that resolved to nothing forwards nothing.
    await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      {
        ...base,
        secrets: fakeSecrets({ GH_TOKEN: "gho_x" }),
        sandboxExposedNames: async () => ["GH_TOKEN", "DELETED_SECRET"],
      },
    );
    expect(deployedEnvs[1].EDEN_SANDBOX_ENV).toBe("GH_TOKEN");
  });

  it("omits EDEN_SANDBOX_ENV when nothing is exposed, and strips a user secret squatting the name", async () => {
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "d4".repeat(20) },
      store,
    );
    const deployedEnvs: Record<string, string>[] = [];
    const base = {
      store,
      deployTarget: fakeDeployTarget({
        health: { status: "live" as const },
        deployedEnvs,
      }),
    };

    await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      {
        ...base,
        secrets: fakeSecrets({ GH_TOKEN: "gho_x" }),
        sandboxExposedNames: async () => [],
      },
    );
    expect(deployedEnvs[0]).not.toHaveProperty("EDEN_SANDBOX_ENV");

    // The variable is Eden-owned: a user secret named EDEN_SANDBOX_ENV must never smuggle
    // its own allowlist into the sandbox.
    await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      {
        ...base,
        secrets: fakeSecrets({
          EDEN_SANDBOX_ENV: "PRIVATE",
          PRIVATE: "keep-out",
        }),
        sandboxExposedNames: async () => [],
      },
    );
    expect(deployedEnvs[1]).not.toHaveProperty("EDEN_SANDBOX_ENV");

    // Deps without the lookup (older callers/tests) behave as "nothing exposed".
    await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      { ...base, secrets: fakeSecrets({ GH_TOKEN: "gho_x" }) },
    );
    expect(deployedEnvs[2]).not.toHaveProperty("EDEN_SANDBOX_ENV");
  });

  it("strips a SHARED secret squatting EDEN_SANDBOX_ENV after the merged resolve (§11.9)", async () => {
    const crypto = await import("node:crypto");
    const { makeLocalSecretsProvider } =
      await import("~/seams/oss/secrets.local.server");
    const { makeFakeSecretKV } = await import("../fakes/secret-kv");
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "e5".repeat(20) },
      store,
    );
    const deployedEnvs: Record<string, string>[] = [];

    // A project-level shared secret named EDEN_SANDBOX_ENV, attached to the agent, resolves
    // through the real provider merge — and must still be deleted before Eden sets its own.
    const kv = makeFakeSecretKV();
    const boxKey = crypto.randomBytes(32);
    const secrets = makeLocalSecretsProvider(kv, () => boxKey);
    await secrets.set(
      {
        projectId: PROJECT,
        agentId: null,
        environmentId: null,
        key: "EDEN_SANDBOX_ENV",
      },
      "SMUGGLED",
    );
    await secrets.set(
      {
        projectId: PROJECT,
        agentId: AGENT,
        environmentId: null,
        key: "GH_TOKEN",
      },
      "gho_x",
    );
    kv.attach(AGENT, "EDEN_SANDBOX_ENV");

    await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      {
        store,
        deployTarget: fakeDeployTarget({
          health: { status: "live" as const },
          deployedEnvs,
        }),
        secrets,
        sandboxExposedNames: async () => ["GH_TOKEN"],
      },
    );
    expect(deployedEnvs[0].EDEN_SANDBOX_ENV).toBe("GH_TOKEN"); // Eden-owned, never "SMUGGLED"
    expect(deployedEnvs[0].GH_TOKEN).toBe("gho_x");
  });

  it("keys the Workflow world by ENVIRONMENT — two deploys of one env share a worldKey", async () => {
    // The durability invariant this feature exists for: a redeploy reuses the environment's
    // world (so sessions + their sandboxes survive), which means the worldKey must be stable
    // across deploys and equal to the environment id — never the (per-deploy) deployment id.
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "b2".repeat(20) },
      store,
    );
    const deployedWorldKeys: string[] = [];
    const deps = {
      store,
      deployTarget: fakeDeployTarget({
        health: { status: "live" as const },
        deployedWorldKeys,
      }),
      secrets: fakeSecrets(),
    };
    const d1 = await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      deps,
    );
    const d2 = await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      deps,
    );
    expect(d1.id).not.toBe(d2.id); // two distinct deployments…
    expect(deployedWorldKeys).toEqual([ENV, ENV]); // …one shared, env-keyed world
  });

  it("rebuilds an already-built release when requested", async () => {
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "ab".repeat(20) },
      store,
    );
    const builtRefs: string[] = [];

    const first = await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      {
        store,
        deployTarget: fakeDeployTarget({
          health: { status: "live", url: "http://first" },
          buildImageRef: "img:first",
          builtRefs,
        }),
        secrets: fakeSecrets(),
      },
    );
    expect(first.status).toBe("live");
    expect((await store.releases.findById(release.id))?.imageRef).toBe(
      "img:first",
    );

    const rebuilt = await deployRelease(
      { environmentId: ENV, releaseId: release.id, rebuild: true },
      {
        store,
        deployTarget: fakeDeployTarget({
          health: { status: "live", url: "http://rebuilt" },
          buildImageRef: "img:rebuilt",
          builtRefs,
        }),
        secrets: fakeSecrets(),
      },
    );

    expect(rebuilt.status).toBe("live");
    expect((await store.releases.findById(release.id))?.imageRef).toBe(
      "img:rebuilt",
    );
    expect(builtRefs).toEqual(["img:first", "img:rebuilt"]);
  });

  it("records failed status WITH the reason when the target throws", async () => {
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "f".repeat(40) },
      store,
    );
    const dep = await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      {
        store,
        deployTarget: fakeDeployTarget({ deployError: "docker unavailable" }),
        secrets: fakeSecrets(),
      },
    );
    expect(dep.status).toBe("failed");
    expect(dep.errorDetail).toBe("docker unavailable");
  });

  it("stops a failed/unhealthy new instance so its schedules cannot keep running", async () => {
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "7".repeat(40) },
      store,
    );
    const stoppedIds: string[] = [];
    const dep = await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      {
        store,
        deployTarget: fakeDeployTarget({
          health: {
            status: "failed",
            url: "http://bad",
            detail: "container did not become healthy",
          },
          stoppedIds,
        }),
        secrets: fakeSecrets(),
      },
    );

    expect(dep.status).toBe("failed");
    expect(dep.errorDetail).toBe("container did not become healthy");
    expect(stoppedIds).toContain(dep.id);
  });
});

describe("queueDeploy", () => {
  it("creates the queued row FIRST, and the job takes over that same row (no duplicate)", async () => {
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "9".repeat(40) },
      store,
    );

    // Click: row exists immediately in `queued` — this is the UI's instant feedback.
    const queued = await queueDeploy(
      { environmentId: ENV, releaseId: release.id, createdBy: "user_1" },
      store,
    );
    expect(queued.status).toBe("queued");
    expect((await listDeployments(ENV, store)).map((d) => d.id)).toEqual([
      queued.id,
    ]);

    // Worker: claims the job, whose payload points at the pre-created row.
    const job = await store.jobs.claimNext(new Date());
    expect(job?.kind).toBe("deploy_release");
    expect(job?.payload.deploymentId).toBe(queued.id);

    // Executing the deploy updates that row — never inserts a second one.
    const done = await deployRelease(
      job!.payload as {
        environmentId: string;
        releaseId: string;
        deploymentId: string;
      },
      {
        store,
        deployTarget: fakeDeployTarget({
          health: { status: "live", url: "http://z" },
        }),
        secrets: fakeSecrets(),
      },
    );
    expect(done.id).toBe(queued.id);
    expect(done.status).toBe("live");
    expect(await listDeployments(ENV, store)).toHaveLength(1);
  });

  it("preserves the rebuild flag in the queued deploy job", async () => {
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "a9".repeat(20) },
      store,
    );

    const queued = await queueDeploy(
      {
        environmentId: ENV,
        releaseId: release.id,
        rebuild: true,
        createdBy: "user_1",
      },
      store,
    );
    const job = await store.jobs.claimNext(new Date());

    expect(queued.status).toBe("queued");
    expect(job?.kind).toBe("deploy_release");
    expect(job?.payload).toMatchObject({
      environmentId: ENV,
      releaseId: release.id,
      deploymentId: queued.id,
      rebuild: true,
      createdBy: "user_1",
    });
  });
});

describe("cutover on deploy", () => {
  it("redeploying the same release supersedes the previous live instance — never two live copies", async () => {
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "8".repeat(40) },
      store,
    );
    const deps = {
      store,
      deployTarget: fakeDeployTarget({
        health: { status: "live", url: "http://a" },
      }),
      secrets: fakeSecrets(),
    };
    const first = await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      deps,
    );
    expect(first.status).toBe("live");

    const second = await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      deps,
    );
    expect(second.status).toBe("live");

    const all = await listDeployments(ENV, store);
    const oldRow = all.find((d) => d.id === first.id);
    expect(oldRow?.status).toBe("stopped");
    expect(oldRow?.trafficWeight).toBe(0);
    // Exactly one live copy of the release remains.
    expect(all.filter((d) => d.status === "live")).toHaveLength(1);
  });

  it("deploying a DIFFERENT release demotes the previously live one (single live per env)", async () => {
    const rA = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "3".repeat(40) },
      store,
    );
    const rB = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "4".repeat(40) },
      store,
    );
    const deps = {
      store,
      deployTarget: fakeDeployTarget({
        health: { status: "live", url: "http://a" },
      }),
      secrets: fakeSecrets(),
    };
    const depA = await deployRelease(
      { environmentId: ENV, releaseId: rA.id },
      deps,
    );
    expect(depA.status).toBe("live");

    const depB = await deployRelease(
      { environmentId: ENV, releaseId: rB.id },
      deps,
    );
    expect(depB.status).toBe("live");

    const all = await listDeployments(ENV, store);
    const oldRow = all.find((d) => d.id === depA.id);
    expect(oldRow?.status).toBe("stopped");
    expect(oldRow?.trafficWeight).toBe(0);
    expect(all.filter((d) => d.status === "live")).toHaveLength(1);

    expect(await store.jobs.claimNext(new Date())).toBeNull();
    const cleanupJob = await store.jobs.claimNext(
      new Date(Date.now() + DEPLOYMENT_CONTAINER_CLEANUP_GRACE_MS + 1000),
    );
    expect(cleanupJob?.kind).toBe("cleanup_deployment_container");
    expect(cleanupJob?.payload).toEqual({ deploymentId: depA.id });
  });

  it("does not hide a stale old instance when cutover cannot stop it", async () => {
    const rA = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "a".repeat(40) },
      store,
    );
    const rB = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "b".repeat(40) },
      store,
    );
    const first = await deployRelease(
      { environmentId: ENV, releaseId: rA.id },
      {
        store,
        deployTarget: fakeDeployTarget({
          health: { status: "live", url: "http://old" },
        }),
        secrets: fakeSecrets(),
      },
    );
    expect(first.status).toBe("live");

    const brokenStop = fakeDeployTarget({
      health: { status: "live", url: "http://new" },
      stopError: "docker daemon unreachable",
    });
    delete (brokenStop as Partial<typeof brokenStop>).destroy;
    const second = await deployRelease(
      { environmentId: ENV, releaseId: rB.id },
      { store, deployTarget: brokenStop, secrets: fakeSecrets() },
    );

    expect(second.status).toBe("failed");
    expect(second.errorDetail).toMatch(
      /cutover failed while stopping the previous deployment/,
    );

    const all = await listDeployments(ENV, store);
    expect(all.find((d) => d.id === first.id)?.status).toBe("live");
    expect(all.find((d) => d.id === second.id)?.status).toBe("failed");
    expect(all.filter((d) => d.status === "live")).toHaveLength(1);
  });

  it("a FAILED deploy leaves the current live version serving (cutover only on success)", async () => {
    const rA = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "5".repeat(40) },
      store,
    );
    const rB = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "6".repeat(40) },
      store,
    );
    const good = {
      store,
      deployTarget: fakeDeployTarget({
        health: { status: "live" as const, url: "http://a" },
      }),
      secrets: fakeSecrets(),
    };
    const depA = await deployRelease(
      { environmentId: ENV, releaseId: rA.id },
      good,
    );
    expect(depA.status).toBe("live");

    const bad = {
      store,
      deployTarget: fakeDeployTarget({ deployError: "boom" }),
      secrets: fakeSecrets(),
    };
    const depB = await deployRelease(
      { environmentId: ENV, releaseId: rB.id },
      bad,
    );
    expect(depB.status).toBe("failed");

    const all = await listDeployments(ENV, store);
    expect(all.find((d) => d.id === depA.id)?.status).toBe("live");
  });
});

describe("cleanupDeploymentContainer", () => {
  it("destroys a stopped, zero-weight deployment only when a live replacement exists", async () => {
    const rA = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "c".repeat(40) },
      store,
    );
    const rB = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "d".repeat(40) },
      store,
    );
    const destroyedIds: string[] = [];
    const deps = {
      store,
      deployTarget: fakeDeployTarget({
        health: { status: "live", url: "http://a" },
        destroyedIds,
      }),
      secrets: fakeSecrets(),
    };

    const old = await deployRelease(
      { environmentId: ENV, releaseId: rA.id },
      deps,
    );
    await deployRelease({ environmentId: ENV, releaseId: rB.id }, deps);

    const result = await cleanupDeploymentContainer(old.id, deps);

    expect(result).toEqual({ status: "destroyed" });
    expect(destroyedIds).toContain(old.id);
  });

  it("skips cleanup for live deployments", async () => {
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "e".repeat(40) },
      store,
    );
    const destroyedIds: string[] = [];
    const deps = {
      store,
      deployTarget: fakeDeployTarget({ destroyedIds }),
      secrets: fakeSecrets(),
    };
    const dep = await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      deps,
    );

    const result = await cleanupDeploymentContainer(dep.id, deps);

    expect(result).toEqual({ status: "skipped", reason: "deployment is live" });
    expect(destroyedIds).toEqual([]);
  });

  it("skips stopped deployments without a live replacement", async () => {
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "f".repeat(40) },
      store,
    );
    const destroyedIds: string[] = [];
    const dep = await store.deployments.insert({
      environmentId: ENV,
      releaseId: release.id,
      status: "stopped",
      trafficWeight: 0,
    });

    const result = await cleanupDeploymentContainer(dep.id, {
      store,
      deployTarget: fakeDeployTarget({ destroyedIds }),
    });

    expect(result).toEqual({
      status: "skipped",
      reason: "no live replacement in environment",
    });
    expect(destroyedIds).toEqual([]);
  });

  it("destroys failed deployments even when no replacement exists", async () => {
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "0".repeat(40) },
      store,
    );
    const destroyedIds: string[] = [];
    const dep = await store.deployments.insert({
      environmentId: ENV,
      releaseId: release.id,
      status: "failed",
      trafficWeight: 100,
    });

    const result = await cleanupDeploymentContainer(dep.id, {
      store,
      deployTarget: fakeDeployTarget({ destroyedIds }),
    });

    expect(result).toEqual({ status: "destroyed" });
    expect(destroyedIds).toContain(dep.id);
  });
});

describe("rollbackTo", () => {
  it("redeploys the prior release at 100 and demotes the current live version", async () => {
    const rA = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "1".repeat(40) },
      store,
    );
    const deps = {
      store,
      deployTarget: fakeDeployTarget({
        health: { status: "live", url: "http://a" },
      }),
      secrets: fakeSecrets(),
    };
    const depA = await deployRelease(
      { environmentId: ENV, releaseId: rA.id },
      deps,
    );
    expect(depA.status).toBe("live");

    const rolled = await rollbackTo(
      { environmentId: ENV, releaseId: rA.id },
      deps,
    );
    expect(rolled.status).toBe("live");
    expect(rolled.trafficWeight).toBe(100);

    const all = await listDeployments(ENV, store);
    const demoted = all.find((d) => d.id === depA.id);
    expect(demoted?.status).toBe("stopped");
    expect(demoted?.trafficWeight).toBe(0);
    expect(all.filter((d) => d.status === "live")).toHaveLength(1);
  });
});

describe("team delegation env injection (D3)", () => {
  const OLD_KEY = process.env.EDEN_SECRETS_KEY;
  beforeEach(() => {
    process.env.EDEN_SECRETS_KEY = "a".repeat(64); // 32-byte key as 64 hex chars
    store.seedAgent({
      id: "pm",
      projectId: PROJECT,
      name: "pm",
      root: "agents/pm/agent",
    });
    store.seedAgent({
      id: "deployer",
      projectId: PROJECT,
      name: "deployer",
      root: "agents/deployer/agent",
    });
    store.seedEnvironment({
      id: "env_pm",
      projectId: PROJECT,
      agentId: "pm",
      name: "production",
    });
  });
  afterEach(() => {
    if (OLD_KEY === undefined) delete process.env.EDEN_SECRETS_KEY;
    else process.env.EDEN_SECRETS_KEY = OLD_KEY;
  });

  function capturingTarget(
    builtReqs: Parameters<DeployTarget["build"]>[0][],
    deployedEnvs: Record<string, string>[],
  ): DeployTarget {
    return {
      name: "cap",
      async build(req) {
        builtReqs.push(req);
        return { imageRef: "img:fake", digest: "sha256:fake" };
      },
      async deploy(req) {
        deployedEnvs.push(req.env);
        return { status: "live", url: "http://x" };
      },
      async stop() {},
      async start() {
        return { status: "live" };
      },
      async health() {
        return { status: "stopped" };
      },
    };
  }

  it("bakes the tool flag and injects EDEN_TEAM_* for a team member", async () => {
    const builtReqs: Parameters<DeployTarget["build"]>[0][] = [];
    const deployedEnvs: Record<string, string>[] = [];
    const release = await createRelease(
      { projectId: PROJECT, agentId: "pm", gitSha: "d4".repeat(20) },
      store,
    );
    const dep = await deployRelease(
      { environmentId: "env_pm", releaseId: release.id },
      {
        store,
        deployTarget: capturingTarget(builtReqs, deployedEnvs),
        secrets: fakeSecrets({ OPENROUTER_API_KEY: "k" }),
      },
    );
    expect(dep.status).toBe("live");
    expect(builtReqs[0].injectTeammateTool).toBe(true);
    const env = deployedEnvs[0];
    expect(env.EDEN_TEAM_URL).toBeTruthy();
    expect(env.EDEN_TEAM_TOKEN.startsWith("ednt_")).toBe(true);
    // Roster excludes self (pm); the description blurb is the deployer's first paragraph.
    const teammates = JSON.parse(env.EDEN_TEAMMATES) as {
      name: string;
      role: string;
    }[];
    expect(teammates).toContainEqual({
      name: "deployer",
      role: "Deploys builds to production.",
    });
    expect(teammates.map((t) => t.name)).not.toContain("pm");
  });

  it("does not inject team env for a single-agent repo", async () => {
    const deployedEnvs: Record<string, string>[] = [];
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "e5".repeat(20) },
      store,
    );
    await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      {
        store,
        deployTarget: fakeDeployTarget({
          health: { status: "live" },
          deployedEnvs,
        }),
        secrets: fakeSecrets({ OPENROUTER_API_KEY: "k" }),
      },
    );
    expect(deployedEnvs[0].EDEN_TEAM_URL).toBeUndefined();
    expect(deployedEnvs[0].EDEN_TEAM_TOKEN).toBeUndefined();
  });
});

describe("shared Discord app env injection (issue #32)", () => {
  const OLD = {
    appId: process.env.EDEN_DISCORD_APPLICATION_ID,
    botToken: process.env.EDEN_DISCORD_BOT_TOKEN,
    publicKey: process.env.EDEN_DISCORD_PUBLIC_KEY,
  };
  afterEach(() => {
    for (const [k, v] of [
      ["EDEN_DISCORD_APPLICATION_ID", OLD.appId],
      ["EDEN_DISCORD_BOT_TOKEN", OLD.botToken],
      ["EDEN_DISCORD_PUBLIC_KEY", OLD.publicKey],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("injects the public credentials + send URL and strips the bot token, even if a user secret sets it", async () => {
    process.env.EDEN_DISCORD_APPLICATION_ID = "app_shared";
    process.env.EDEN_DISCORD_BOT_TOKEN = "bot_shared";
    process.env.EDEN_DISCORD_PUBLIC_KEY = "pub_shared";
    const deployedEnvs: Record<string, string>[] = [];
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "f6".repeat(20) },
      store,
    );
    await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      {
        store,
        deployTarget: fakeDeployTarget({
          health: { status: "live" },
          deployedEnvs,
        }),
        // A user secret trying to smuggle a bot token — Eden must strip it.
        secrets: fakeSecrets({
          OPENROUTER_API_KEY: "k",
          DISCORD_BOT_TOKEN: "user_bot",
          DISCORD_APPLICATION_ID: "user_app",
        }),
      },
    );
    const env = deployedEnvs[0];
    expect(env.DISCORD_APPLICATION_ID).toBe("app_shared");
    expect(env.DISCORD_PUBLIC_KEY).toBe("pub_shared");
    expect(env.EDEN_DISCORD_SEND_URL).toMatch(/\/api\/discord\/send$/);
    expect(env).not.toHaveProperty("DISCORD_BOT_TOKEN");
  });

  it("leaves user-resolved Discord secrets untouched when the operator app is absent", async () => {
    delete process.env.EDEN_DISCORD_APPLICATION_ID;
    delete process.env.EDEN_DISCORD_BOT_TOKEN;
    delete process.env.EDEN_DISCORD_PUBLIC_KEY;
    const deployedEnvs: Record<string, string>[] = [];
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "a7".repeat(20) },
      store,
    );
    await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      {
        store,
        deployTarget: fakeDeployTarget({
          health: { status: "live" },
          deployedEnvs,
        }),
        secrets: fakeSecrets({
          OPENROUTER_API_KEY: "k",
          DISCORD_BOT_TOKEN: "user_bot",
          DISCORD_APPLICATION_ID: "user_app",
        }),
      },
    );
    const env = deployedEnvs[0];
    expect(env.DISCORD_BOT_TOKEN).toBe("user_bot");
    expect(env.DISCORD_APPLICATION_ID).toBe("user_app");
    expect(env).not.toHaveProperty("EDEN_DISCORD_SEND_URL");
  });
});

describe("setTrafficSplit", () => {
  it("applies weights within the environment and clamps negatives to 0", async () => {
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "2".repeat(40) },
      store,
    );
    const deps = {
      store,
      deployTarget: fakeDeployTarget({
        health: { status: "live", url: "http://y" },
      }),
      secrets: fakeSecrets(),
    };
    const d1 = await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      deps,
    );
    const d2 = await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      deps,
    );

    await setTrafficSplit(
      ENV,
      [
        { deploymentId: d1.id, weight: 90 },
        { deploymentId: d2.id, weight: 10 },
      ],
      store,
    );
    let all = await listDeployments(ENV, store);
    expect(all.find((d) => d.id === d1.id)?.trafficWeight).toBe(90);
    expect(all.find((d) => d.id === d2.id)?.trafficWeight).toBe(10);

    await setTrafficSplit(ENV, [{ deploymentId: d2.id, weight: -5 }], store);
    all = await listDeployments(ENV, store);
    expect(all.find((d) => d.id === d2.id)?.trafficWeight).toBe(0);
  });
});
