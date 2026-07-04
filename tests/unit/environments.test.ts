/**
 * User-defined environments (M5.7) — lifecycle + seeding against in-memory fakes. Verifies
 * the invariants the feature hangs on: ensureDefault only fires for members with zero envs
 * (so roster self-heals never re-seed), CRUD validates names and reports duplicates
 * readably, delete tears down instance infra and never removes a member's last env, and
 * environment lists are deterministically ordered (createdAt, then id).
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  createEnvironment,
  deleteEnvironment,
  renameEnvironment,
} from "~/deploy/environments.server";
import { createProject, syncProjectAgents } from "~/db/queries.server";
import { createRelease, deployRelease } from "~/deploy/controller.server";
import { fakeDeployTarget, fakeSecrets } from "../fakes/infra";
import { makeFakeStore, type FakeStore } from "../fakes/store";

let store: FakeStore;
const ORG = "org_1";

beforeEach(() => {
  store = makeFakeStore();
});

describe("seeding (ensureDefault)", () => {
  it("a new project's members each get exactly one environment named default", async () => {
    const project = await createProject(
      {
        orgId: ORG,
        name: "Team",
        roster: [
          { name: "alpha", root: "agents/alpha/agent" },
          { name: "beta", root: "agents/beta/agent" },
        ],
      },
      store,
    );
    for (const agent of await store.agents.listByProject(project.id)) {
      const envs = await store.environments.listByAgent(agent.id);
      expect(envs.map((e) => e.name)).toEqual(["default"]);
    }
  });

  it("a roster re-sync never re-seeds a member that has environments — renames survive", async () => {
    const project = await createProject(
      { orgId: ORG, name: "Solo", roster: [{ name: "agent", root: "agent" }] },
      store,
    );
    const [agent] = await store.agents.listByProject(project.id);
    const [env] = await store.environments.listByAgent(agent.id);
    await store.environments.rename(env.id, "production");

    await syncProjectAgents(project.id, [{ name: "agent", root: "agent" }], store);

    const envs = await store.environments.listByAgent(agent.id);
    expect(envs.map((e) => e.name)).toEqual(["production"]); // no "default" re-appeared
  });
});

describe("createEnvironment / renameEnvironment", () => {
  let projectId: string;
  let agentId: string;

  beforeEach(async () => {
    const project = await createProject(
      { orgId: ORG, name: "Solo", roster: [{ name: "agent", root: "agent" }] },
      store,
    );
    projectId = project.id;
    agentId = (await store.agents.listByProject(projectId))[0].id;
  });

  const deps = () => ({ store, deployTarget: fakeDeployTarget() });

  it("creates and lists in creation order (the first is the primary)", async () => {
    await createEnvironment({ projectId, agentId, name: "staging", orgId: ORG }, deps());
    const envs = await store.environments.listByAgent(agentId);
    expect(envs.map((e) => e.name)).toEqual(["default", "staging"]);
  });

  it("trims and rejects empty or duplicate names with a readable error", async () => {
    await expect(
      createEnvironment({ projectId, agentId, name: "   ", orgId: ORG }, deps()),
    ).rejects.toThrow(/name is required/i);
    await expect(
      createEnvironment({ projectId, agentId, name: "default", orgId: ORG }, deps()),
    ).rejects.toThrow(/already exists/i);
  });

  it("renames in place; deploys and ids stay attached", async () => {
    const [env] = await store.environments.listByAgent(agentId);
    await renameEnvironment(
      { environmentId: env.id, name: "production", orgId: ORG },
      deps(),
    );
    expect((await store.environments.findById(env.id))?.name).toBe("production");
  });

  it("rename to an existing sibling name is rejected readably", async () => {
    await createEnvironment({ projectId, agentId, name: "staging", orgId: ORG }, deps());
    const [env] = await store.environments.listByAgent(agentId);
    await expect(
      renameEnvironment({ environmentId: env.id, name: "staging", orgId: ORG }, deps()),
    ).rejects.toThrow(/already exists/i);
  });
});

describe("deleteEnvironment", () => {
  it("destroys the env's instances via the target, then the row (cascade takes deployments)", async () => {
    const project = await createProject(
      { orgId: ORG, name: "Solo", roster: [{ name: "agent", root: "agent" }] },
      store,
    );
    store.seedProject({ id: project.id, orgId: ORG, repoOwner: "acme", repoName: "a" });
    const agentId = (await store.agents.listByProject(project.id))[0].id;
    const [defaultEnv] = await store.environments.listByAgent(agentId);
    const staging = await store.environments.create({
      projectId: project.id,
      agentId,
      name: "staging",
    });

    const destroyed: string[] = [];
    const target = fakeDeployTarget({ health: { status: "live", url: "http://x" } });
    const release = await createRelease(
      { projectId: project.id, agentId, gitSha: "a".repeat(40) },
      store,
    );
    const dep = await deployRelease(
      { environmentId: staging.id, releaseId: release.id },
      { store, deployTarget: target, secrets: fakeSecrets() },
    );
    expect(dep.status).toBe("live");

    await deleteEnvironment(
      { environmentId: staging.id, orgId: ORG },
      {
        store,
        deployTarget: {
          ...target,
          destroy: async (id) => {
            destroyed.push(id);
          },
        },
      },
    );

    expect(destroyed).toEqual([dep.id]); // live instance was torn down, not orphaned
    expect(await store.environments.findById(staging.id)).toBeNull();
    expect(await store.deployments.listByEnvironment(staging.id)).toHaveLength(0);
    expect(await store.environments.findById(defaultEnv.id)).not.toBeNull();
  });

  it("refuses to delete a member's last environment", async () => {
    const project = await createProject(
      { orgId: ORG, name: "Solo", roster: [{ name: "agent", root: "agent" }] },
      store,
    );
    const agentId = (await store.agents.listByProject(project.id))[0].id;
    const [only] = await store.environments.listByAgent(agentId);
    await expect(
      deleteEnvironment(
        { environmentId: only.id, orgId: ORG },
        { store, deployTarget: fakeDeployTarget() },
      ),
    ).rejects.toThrow(/at least one/i);
    expect(await store.environments.findById(only.id)).not.toBeNull();
  });

  it("falls back to stop() when the target has no destroy()", async () => {
    const project = await createProject(
      { orgId: ORG, name: "Solo", roster: [{ name: "agent", root: "agent" }] },
      store,
    );
    const agentId = (await store.agents.listByProject(project.id))[0].id;
    const staging = await store.environments.create({
      projectId: project.id,
      agentId,
      name: "staging",
    });
    const release = await createRelease(
      { projectId: project.id, agentId, gitSha: "b".repeat(40) },
      store,
    );
    const stopped: string[] = [];
    const target = fakeDeployTarget({ health: { status: "live", url: "http://x" } });
    const dep = await deployRelease(
      { environmentId: staging.id, releaseId: release.id },
      { store, deployTarget: target, secrets: fakeSecrets() },
    );

    const noDestroy = {
      ...target,
      destroy: undefined,
      stop: async (id: string) => {
        stopped.push(id);
      },
    };
    await deleteEnvironment(
      { environmentId: staging.id, orgId: ORG },
      { store, deployTarget: noDestroy },
    );
    expect(stopped).toContain(dep.id);
  });
});
