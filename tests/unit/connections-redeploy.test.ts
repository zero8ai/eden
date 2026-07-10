/**
 * Auto-redeploy after connect/reconnect (issue #69). Verifies the decision logic against injected
 * fakes: it redeploys every LIVE environment (image reused) so a fresh grant reaches the running
 * container, but stays hands-off when the agent isn't deployed or has staged changes, and surfaces
 * queue errors instead of throwing.
 */
import { describe, expect, it, vi } from "vitest";

import {
  redeployAfterConnect,
  type RedeployAfterConnectDeps,
} from "~/connections/redeploy.server";
import type { DeploymentWithRelease, DraftChange, Environment } from "~/data/ports";

const PROJECT = "proj_1";
const AGENT = "agent_1";

function env(id: string, name: string): Environment {
  return { id, name, agentId: AGENT } as unknown as Environment;
}

function liveDep(releaseId: string): DeploymentWithRelease {
  return {
    id: `dep_${releaseId}`,
    status: "live",
    trafficWeight: 100,
    url: "http://x",
    errorDetail: null,
    createdAt: new Date(),
    releaseId,
    version: "v1",
    gitSha: "a".repeat(40),
  };
}

function draft(agentId: string | null): DraftChange {
  return { id: `draft_${agentId ?? "shared"}`, projectId: PROJECT, agentId } as unknown as DraftChange;
}

function deps(over: Partial<RedeployAfterConnectDeps> = {}): RedeployAfterConnectDeps {
  return {
    listDrafts: async () => [],
    listAgentEnvironments: async () => [env("env_1", "production")],
    listDeployments: async () => [liveDep("rel_1")],
    ensureWorkerStarted: () => {},
    queueDeploy: async () => ({}),
    ...over,
  };
}

describe("redeployAfterConnect", () => {
  it("returns not-deployed and queues nothing when no environment is live", async () => {
    const queueDeploy = vi.fn(async () => ({}));
    const out = await redeployAfterConnect(
      { projectId: PROJECT, agentId: AGENT },
      deps({ listDeployments: async () => [], queueDeploy }),
    );
    expect(out).toEqual({ status: "not-deployed" });
    expect(queueDeploy).not.toHaveBeenCalled();
  });

  it("returns staged and queues nothing when a draft for this agent exists", async () => {
    const queueDeploy = vi.fn(async () => ({}));
    const out = await redeployAfterConnect(
      { projectId: PROJECT, agentId: AGENT },
      deps({ listDrafts: async () => [draft(AGENT)], queueDeploy }),
    );
    expect(out).toEqual({ status: "staged" });
    expect(queueDeploy).not.toHaveBeenCalled();
  });

  it("returns staged for a shared (null-agent) draft", async () => {
    const queueDeploy = vi.fn(async () => ({}));
    const out = await redeployAfterConnect(
      { projectId: PROJECT, agentId: AGENT },
      deps({ listDrafts: async () => [draft(null)], queueDeploy }),
    );
    expect(out).toEqual({ status: "staged" });
    expect(queueDeploy).not.toHaveBeenCalled();
  });

  it("redeploys the live env (image reused) and reports it when there are no relevant drafts", async () => {
    const queueDeploy = vi.fn(async () => ({}));
    const ensureWorkerStarted = vi.fn();
    const out = await redeployAfterConnect(
      { projectId: PROJECT, agentId: AGENT, createdBy: "user_1" },
      deps({ queueDeploy, ensureWorkerStarted }),
    );
    expect(out).toEqual({ status: "redeployed", envNames: ["production"] });
    expect(ensureWorkerStarted).toHaveBeenCalledOnce();
    expect(queueDeploy).toHaveBeenCalledOnce();
    expect(queueDeploy).toHaveBeenCalledWith({
      environmentId: "env_1",
      releaseId: "rel_1",
      rollback: true,
      createdBy: "user_1",
    });
  });

  it("does NOT block on a draft belonging to a different agent", async () => {
    const queueDeploy = vi.fn(async () => ({}));
    const out = await redeployAfterConnect(
      { projectId: PROJECT, agentId: AGENT },
      deps({ listDrafts: async () => [draft("other_agent")], queueDeploy }),
    );
    expect(out).toEqual({ status: "redeployed", envNames: ["production"] });
    expect(queueDeploy).toHaveBeenCalledOnce();
  });

  it("returns error with the message when queueDeploy throws", async () => {
    const out = await redeployAfterConnect(
      { projectId: PROJECT, agentId: AGENT },
      deps({
        queueDeploy: async () => {
          throw new Error("queue is down");
        },
      }),
    );
    expect(out).toEqual({ status: "error", message: "queue is down" });
  });

  it("redeploys every live environment and returns all their names", async () => {
    const queued: { environmentId: string; releaseId: string }[] = [];
    const out = await redeployAfterConnect(
      { projectId: PROJECT, agentId: AGENT },
      deps({
        listAgentEnvironments: async () => [
          env("env_stg", "staging"),
          env("env_prod", "production"),
        ],
        listDeployments: async (environmentId) =>
          environmentId === "env_stg" ? [liveDep("rel_stg")] : [liveDep("rel_prod")],
        queueDeploy: async (input) => {
          queued.push({ environmentId: input.environmentId, releaseId: input.releaseId });
          return {};
        },
      }),
    );
    expect(out).toEqual({ status: "redeployed", envNames: ["staging", "production"] });
    expect(queued).toEqual([
      { environmentId: "env_stg", releaseId: "rel_stg" },
      { environmentId: "env_prod", releaseId: "rel_prod" },
    ]);
  });
});
