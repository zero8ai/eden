/**
 * FOH presence derivation (app/foh/presence.server.ts): the pure ●/○ matrix — including the
 * transient two-live-rows cutover window and the running-session staleness gate — plus the
 * batch assembly over the FakeStore.
 */
import { describe, expect, it } from "vitest";

import {
  agentPresenceMap,
  deriveAgentPresence,
} from "~/foh/presence.server";
import { makeFakeStore } from "../fakes/store";

function derive(over: {
  deploymentStatuses?: string[];
  runningTurnCount?: number;
  hasFreshRunningSession?: boolean;
}) {
  return deriveAgentPresence({
    deploymentStatuses: over.deploymentStatuses ?? [],
    runningTurnCount: over.runningTurnCount ?? 0,
    hasFreshRunningSession: over.hasFreshRunningSession ?? false,
  });
}

describe("deriveAgentPresence", () => {
  it("live deployment with no turn = running", () => {
    expect(derive({ deploymentStatuses: ["live"] })).toBe("running");
  });

  it("live deployment with a running run = active_turn", () => {
    expect(
      derive({ deploymentStatuses: ["live"], runningTurnCount: 1 }),
    ).toBe("active_turn");
  });

  it("live deployment with a fresh running session = active_turn", () => {
    expect(
      derive({ deploymentStatuses: ["live"], hasFreshRunningSession: true }),
    ).toBe("active_turn");
  });

  it("a stale running session does NOT make a live agent active (staleness is the caller's gate)", () => {
    // The fresh flag is computed with the staleness cutoff before derivation — a stale
    // session simply arrives as `false`.
    expect(
      derive({ deploymentStatuses: ["live"], hasFreshRunningSession: false }),
    ).toBe("running");
  });

  it("tolerates the two-live-rows cutover window", () => {
    expect(derive({ deploymentStatuses: ["live", "live"] })).toBe("running");
    expect(
      derive({
        deploymentStatuses: ["live", "live", "draining"],
        runningTurnCount: 2,
      }),
    ).toBe("active_turn");
  });

  it("stopped = idle (scale-to-zero IS the presence indicator)", () => {
    expect(derive({ deploymentStatuses: ["stopped"] })).toBe("idle");
  });

  it("draining / in-flight rows read as idle", () => {
    expect(derive({ deploymentStatuses: ["draining"] })).toBe("idle");
    expect(derive({ deploymentStatuses: ["pending"] })).toBe("idle");
    expect(derive({ deploymentStatuses: ["building"] })).toBe("idle");
  });

  it("failed-only = error, but a wakeable row wins over failed", () => {
    expect(derive({ deploymentStatuses: ["failed"] })).toBe("error");
    expect(derive({ deploymentStatuses: ["failed", "stopped"] })).toBe("idle");
    expect(derive({ deploymentStatuses: ["failed", "live"] })).toBe("running");
  });

  it("never deployed = idle", () => {
    expect(derive({})).toBe("idle");
  });

  it("a turn without any live row never shows active (routing truth first)", () => {
    expect(
      derive({ deploymentStatuses: ["stopped"], runningTurnCount: 3 }),
    ).toBe("idle");
  });
});

describe("agentPresenceMap over the FakeStore", () => {
  it("assembles container + turn state per agent", async () => {
    const store = makeFakeStore();
    store.seedProject({ id: "proj_1", orgId: "org_1" });
    store.seedAgent({ id: "agent_live", projectId: "proj_1", name: "ivy" });
    store.seedAgent({ id: "agent_stopped", projectId: "proj_1", name: "sam" });
    store.seedEnvironment({
      id: "env_live",
      projectId: "proj_1",
      agentId: "agent_live",
    });
    store.seedEnvironment({
      id: "env_stopped",
      projectId: "proj_1",
      agentId: "agent_stopped",
    });
    const release = await store.releases.insert({
      projectId: "proj_1",
      agentId: "agent_live",
      version: "v1",
      gitSha: "abc",
    });
    const liveDep = await store.deployments.insert({
      environmentId: "env_live",
      releaseId: release.id,
      status: "live",
      trafficWeight: 100,
    });
    await store.deployments.update(liveDep.id, { url: "http://inst" });
    const stoppedDep = await store.deployments.insert({
      environmentId: "env_stopped",
      releaseId: release.id,
      status: "stopped",
      trafficWeight: 0,
    });
    // A running run on the STOPPED agent's deployment must not show a phantom turn.
    store.seedRun({
      id: "run_live",
      projectId: "proj_1",
      deploymentId: liveDep.id,
      status: "running",
    });
    store.seedRun({
      id: "run_stale",
      projectId: "proj_1",
      deploymentId: stoppedDep.id,
      status: "running",
    });

    const presence = await agentPresenceMap(["agent_live", "agent_stopped"], {
      store,
      freshRunningAgentIds: async () => new Set(),
    });
    expect(presence.get("agent_live")).toBe("active_turn");
    expect(presence.get("agent_stopped")).toBe("idle");
  });
});
