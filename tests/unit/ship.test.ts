/**
 * Ship orchestration — the one-click pipeline against in-memory fakes (no GitHub, no docker).
 * The TEAM is the deployment unit: verifies the chaining ship owns (publish → merge →
 * release-per-member → queued deploy for the WHOLE roster into one environment, even when the
 * drafts touch a single member), the build-gate leaving drafts staged on failure, and
 * deployTeamVersion moving the whole team to an existing version by git sha, and shipRepoHead
 * deploying the branch HEAD with no staged change-set (idempotent per head sha).
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  deployTeamVersion,
  shipRepoHead,
  shipStagedChanges,
  type ShipDeps,
  type ShipProject,
} from "~/deploy/ship.server";
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
  // Team-level env invariant: every member has a row of every name.
  store.seedEnvironment({ id: "env_a_prod", projectId: PROJECT.id, agentId: "agent_a", name: "production" });
  store.seedEnvironment({ id: "env_a_prev", projectId: PROJECT.id, agentId: "agent_a", name: "preview" });
  store.seedEnvironment({ id: "env_b_prod", projectId: PROJECT.id, agentId: "agent_b", name: "production" });
  store.seedEnvironment({ id: "env_b_prev", projectId: PROJECT.id, agentId: "agent_b", name: "preview" });
});

async function stage(path: string, agentId: string | null) {
  await store.drafts.upsert({ projectId: PROJECT.id, agentId, path, content: "x" });
}

describe("shipStagedChanges", () => {
  it("deploys the WHOLE member roster even when the drafts touch a single member", async () => {
    // Only alpha owns a draft, but the team is the deployment unit → both members deploy.
    await stage("agents/alpha/agent/instructions.md", "agent_a");

    const result = await shipStagedChanges(
      { project: PROJECT, envName: "production", createdBy: "user_1" },
      deps(),
    );

    expect(result.deployed.map((d) => d.agentName).sort()).toEqual(["alpha", "beta"]);
    expect(result.skipped).toEqual([]);
    const queuedA = await store.deployments.listByEnvironment("env_a_prod");
    const queuedB = await store.deployments.listByEnvironment("env_b_prod");
    expect(queuedA).toHaveLength(1);
    expect(queuedB).toHaveLength(1);
    expect(queuedA[0].status).toBe("queued");
    // A release was cut for EVERY roster member at the merge commit (atomic team merge).
    expect(await store.releases.findByCommit("agent_a", MERGE_SHA)).not.toBeNull();
    expect(await store.releases.findByCommit("agent_b", MERGE_SHA)).not.toBeNull();
    // The published drafts were consumed.
    expect(await store.drafts.listByProject(PROJECT.id)).toHaveLength(0);
    // And the worker has a job to pick up.
    expect((await store.jobs.claimNext(new Date()))?.kind).toBe("deploy_release");
  });

  it("ships the whole team to the chosen environment, not just production", async () => {
    await stage("agents/alpha/agent/instructions.md", "agent_a");
    const result = await shipStagedChanges(
      { project: PROJECT, envName: "preview" },
      deps(),
    );
    expect(result.deployed.map((d) => d.environmentId).sort()).toEqual([
      "env_a_prev",
      "env_b_prev",
    ]);
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

describe("shipRepoHead", () => {
  const HEAD_SHA = "face".repeat(10);
  // Injected head reader — no GitHub. Records its ref so we can assert the default branch flows in.
  function fakeBranchHead(sha = HEAD_SHA) {
    const calls: { installationId: string | number; ref?: string }[] = [];
    const fn: ShipDeps["branchHead"] = async (installationId, { ref }) => {
      calls.push({ installationId, ref });
      return { sha, branch: ref ?? "main" };
    };
    return { fn, calls };
  }

  it("deploys the whole member roster from the head sha, no change-set", async () => {
    const branchHead = fakeBranchHead();
    const result = await shipRepoHead(
      { project: PROJECT, envName: "production", createdBy: "user_1" },
      { store, branchHead: branchHead.fn },
    );

    expect(result.gitSha).toBe(HEAD_SHA);
    expect(result.deployed.map((d) => d.agentName).sort()).toEqual(["alpha", "beta"]);
    expect(result.skipped).toEqual([]);
    // A release was cut at the head sha for every roster member.
    expect(await store.releases.findByCommit("agent_a", HEAD_SHA)).not.toBeNull();
    expect(await store.releases.findByCommit("agent_b", HEAD_SHA)).not.toBeNull();
    // Deploys are queued in the requested env for every member.
    const queuedA = await store.deployments.listByEnvironment("env_a_prod");
    const queuedB = await store.deployments.listByEnvironment("env_b_prod");
    expect(queuedA).toHaveLength(1);
    expect(queuedB).toHaveLength(1);
    expect(queuedA[0].status).toBe("queued");
    // And the worker has a deploy job to pick up.
    expect((await store.jobs.claimNext(new Date()))?.kind).toBe("deploy_release");
  });

  it("is idempotent — a second ship at the same head reuses releases and re-queues a deploy", async () => {
    // Pre-existing release at the head sha for alpha (e.g. from a prior click).
    const existing = await store.releases.insert({
      projectId: PROJECT.id,
      agentId: "agent_a",
      version: "v1",
      gitSha: HEAD_SHA,
    });
    const branchHead = fakeBranchHead();

    const result = await shipRepoHead(
      { project: PROJECT, envName: "production" },
      { store, branchHead: branchHead.fn },
    );

    // No duplicate release for alpha at that sha — the existing one was reused.
    const alphaRelease = await store.releases.findByCommit("agent_a", HEAD_SHA);
    expect(alphaRelease?.id).toBe(existing.id);
    // Deploy still queued for the whole team.
    expect(result.deployed.map((d) => d.agentName).sort()).toEqual(["alpha", "beta"]);
    expect((await store.deployments.listByEnvironment("env_a_prod"))[0]?.status).toBe("queued");
  });

  it("throws when no member has the requested environment", async () => {
    const branchHead = fakeBranchHead();
    await expect(
      shipRepoHead(
        { project: PROJECT, envName: "staging" },
        { store, branchHead: branchHead.fn },
      ),
    ).rejects.toThrow(/no "staging" environment/i);
  });

  it("passes the project's default branch through to branchHead as ref", async () => {
    const branchHead = fakeBranchHead();
    await shipRepoHead(
      { project: { ...PROJECT, defaultBranch: "trunk" }, envName: "production" },
      { store, branchHead: branchHead.fn },
    );
    expect(branchHead.calls).toHaveLength(1);
    expect(branchHead.calls[0].ref).toBe("trunk");
    expect(branchHead.calls[0].installationId).toBe(PROJECT.repoInstallationId);
  });
});

describe("deployTeamVersion", () => {
  const SHA = "cafe".repeat(10);

  async function seedRelease(agentId: string, gitSha = SHA) {
    return store.releases.insert({
      projectId: PROJECT.id,
      agentId,
      version: "v1",
      gitSha,
    });
  }

  it("moves the whole team to a version by git sha, into each member's env of that name", async () => {
    await seedRelease("agent_a");
    await seedRelease("agent_b");

    const result = await deployTeamVersion(
      { projectId: PROJECT.id, gitSha: SHA, envName: "production", createdBy: "user_1" },
      { store },
    );

    expect(result.deployed.map((d) => d.agentName).sort()).toEqual(["alpha", "beta"]);
    expect(result.skipped).toEqual([]);
    expect((await store.deployments.listByEnvironment("env_a_prod"))[0]?.status).toBe("queued");
    expect((await store.deployments.listByEnvironment("env_b_prod"))[0]?.status).toBe("queued");
  });

  it("skips a member that has no release at that sha, deploys the rest", async () => {
    await seedRelease("agent_a"); // only alpha has a release at SHA

    const result = await deployTeamVersion(
      { projectId: PROJECT.id, gitSha: SHA, envName: "production" },
      { store },
    );

    expect(result.deployed.map((d) => d.agentName)).toEqual(["alpha"]);
    expect(result.skipped).toEqual([{ agentName: "beta" }]);
  });

  it("throws when no member has that version in that environment", async () => {
    await seedRelease("agent_a");
    await seedRelease("agent_b");
    await expect(
      deployTeamVersion(
        { projectId: PROJECT.id, gitSha: SHA, envName: "staging" },
        { store },
      ),
    ).rejects.toThrow(/nothing to deploy/i);
  });
});
