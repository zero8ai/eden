/**
 * Ship orchestration — the one-click pipeline against in-memory fakes (no GitHub, no docker).
 * Verifies the chaining ship owns: publish → merge → release-per-member → queued deploy per
 * AFFECTED member, the shared-draft (agentId null) fan-out to everyone, the build-gate leaving
 * drafts staged on failure, and the head-ship variant reusing an existing release.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { shipHead, shipStagedChanges, type ShipDeps, type ShipProject } from "~/deploy/ship.server";
import type { CheckBuildFn, ProposeFn } from "~/drafts/drafts.server";
import { makeFakeStore, type FakeStore } from "../fakes/store";

let store: FakeStore;
const PROJECT: ShipProject = {
  id: "proj_1",
  repoInstallationId: "inst_1",
  repoOwner: "acme",
  repoName: "agents",
  defaultBranch: "main",
};
const MERGE_SHA = "beef".repeat(10);

const propose: ProposeFn = async (_inst, _repo, input) => ({
  branch: input.branch,
  base: input.base ?? "main",
  pullRequestUrl: "https://github.com/acme/agents/pull/7",
  pullRequestNumber: 7,
  reusedPullRequest: false,
});
const buildOk: CheckBuildFn = async () => ({ ok: true, skipped: true });
const merge = async () => ({ mergeSha: MERGE_SHA, method: "squash" as const });

function deps(overrides: Partial<ShipDeps> = {}): ShipDeps {
  return { store, propose, checkBuild: buildOk, merge, ...overrides };
}

beforeEach(() => {
  store = makeFakeStore();
  store.seedProject({ id: PROJECT.id, orgId: "org_1", repoOwner: "acme", repoName: "agents" });
  store.seedAgent({ id: "agent_a", projectId: PROJECT.id, name: "alpha", root: "agents/alpha/agent" });
  store.seedAgent({ id: "agent_b", projectId: PROJECT.id, name: "beta", root: "agents/beta/agent" });
  store.seedEnvironment({ id: "env_a_prod", projectId: PROJECT.id, agentId: "agent_a", name: "production" });
  store.seedEnvironment({ id: "env_a_prev", projectId: PROJECT.id, agentId: "agent_a", name: "preview" });
  store.seedEnvironment({ id: "env_b_prod", projectId: PROJECT.id, agentId: "agent_b", name: "production" });
});

async function stage(path: string, agentId: string | null) {
  await store.drafts.upsert({ projectId: PROJECT.id, agentId, path, content: "x" });
}

describe("shipStagedChanges", () => {
  it("publishes, merges, cuts a release per member, and queues a deploy for the affected member only", async () => {
    await stage("agents/alpha/agent/instructions.md", "agent_a");

    const result = await shipStagedChanges(
      { project: PROJECT, envName: "production", createdBy: "user_1" },
      deps(),
    );

    // Only alpha's production got a deploy; beta's release exists but stays undeployed.
    expect(result.deployed.map((d) => d.agentName)).toEqual(["alpha"]);
    expect(result.deployed[0].environmentId).toBe("env_a_prod");
    const queued = await store.deployments.listByEnvironment("env_a_prod");
    expect(queued).toHaveLength(1);
    expect(queued[0].status).toBe("queued");
    expect(await store.deployments.listByEnvironment("env_b_prod")).toHaveLength(0);
    // A release was still cut for EVERY roster member at the merge commit (atomic team merge).
    expect(await store.releases.findByCommit("agent_a", MERGE_SHA)).not.toBeNull();
    expect(await store.releases.findByCommit("agent_b", MERGE_SHA)).not.toBeNull();
    // The published drafts were consumed.
    expect(await store.drafts.listByProject(PROJECT.id)).toHaveLength(0);
    // And the worker has a job to pick up.
    expect((await store.jobs.claimNext(new Date()))?.kind).toBe("deploy_release");
  });

  it("ships to the chosen environment, not just production", async () => {
    await stage("agents/alpha/agent/instructions.md", "agent_a");
    const result = await shipStagedChanges(
      { project: PROJECT, envName: "preview" },
      deps(),
    );
    expect(result.deployed[0].environmentId).toBe("env_a_prev");
  });

  it("a shared draft (agentId null) fans out to every roster member", async () => {
    await stage("package.json", null);
    await stage("agents/alpha/agent/instructions.md", "agent_a");

    const result = await shipStagedChanges({ project: PROJECT, envName: "production" }, deps());
    expect(result.deployed.map((d) => d.agentName).sort()).toEqual(["alpha", "beta"]);
    expect(result.skipped).toEqual([]);
  });

  it("reports members that have no environment of the target name (user-defined envs diverge)", async () => {
    await stage("package.json", null); // affects both members
    // alpha has "preview"; beta does not.
    const result = await shipStagedChanges({ project: PROJECT, envName: "preview" }, deps());
    expect(result.deployed.map((d) => d.agentName)).toEqual(["alpha"]);
    expect(result.skipped).toEqual([{ agentName: "beta" }]);
  });

  it("throws when nothing is staged", async () => {
    await expect(
      shipStagedChanges({ project: PROJECT, envName: "production" }, deps()),
    ).rejects.toThrow(/nothing staged/i);
  });

  it("a failed build-gate creates nothing and leaves the drafts staged", async () => {
    await stage("agents/alpha/agent/instructions.md", "agent_a");
    const buildFail: CheckBuildFn = async () => ({ ok: false, output: "tsc exploded" });

    await expect(
      shipStagedChanges({ project: PROJECT, envName: "production" }, deps({ checkBuild: buildFail })),
    ).rejects.toThrow(/build check failed/i);

    expect(await store.drafts.listByProject(PROJECT.id)).toHaveLength(1);
    expect(await store.releases.findByCommit("agent_a", MERGE_SHA)).toBeNull();
    expect(await store.deployments.listByEnvironment("env_a_prod")).toHaveLength(0);
  });

  it("throws when no member has the requested environment", async () => {
    await stage("agents/alpha/agent/instructions.md", "agent_a");
    await expect(
      shipStagedChanges({ project: PROJECT, envName: "staging" }, deps()),
    ).rejects.toThrow(/no "staging" environment/i);
  });
});

describe("shipHead", () => {
  const branchHead = async () => ({ sha: "a1b2".repeat(10), branch: "main" });

  it("cuts a release at the branch head and deploys it for every member", async () => {
    const result = await shipHead(
      { project: PROJECT, envName: "production" },
      deps({ branchHead }),
    );
    expect(result.deployed.map((d) => d.agentName).sort()).toEqual(["alpha", "beta"]);
    expect((await store.deployments.listByEnvironment("env_a_prod"))[0]?.status).toBe("queued");
  });

  it("is idempotent per commit: a second ship reuses the same release", async () => {
    const first = await shipHead({ project: PROJECT, envName: "production" }, deps({ branchHead }));
    const second = await shipHead({ project: PROJECT, envName: "production" }, deps({ branchHead }));
    expect(second.version).toBe(first.version);
    const releases = await store.releases.listByProject(PROJECT.id);
    expect(releases).toHaveLength(2); // one per member, not per ship
  });
});
