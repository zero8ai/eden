import { describe, expect, it } from "vitest";

import {
  assistantTemplateHash,
  ensureAssistantAgent,
  ensureAssistantInstance,
} from "~/assistant/instance.server";
import { makeFakeStore } from "../fakes/store";

describe("assistant instance: agent + environment", () => {
  it("creates the assistant agent (kind assistant) and its 'assistant' environment", async () => {
    const store = makeFakeStore();
    store.seedProject({ id: "p", orgId: "o", repoOwner: "a", repoName: "r", repoInstallationId: "i" });
    const { agent, environment } = await ensureAssistantAgent("p", store);
    expect(agent).toMatchObject({ kind: "assistant", name: "assistant", root: ".eden/assistant" });
    expect(environment.name).toBe("assistant");
    // Idempotent: a second call returns the same rows.
    const again = await ensureAssistantAgent("p", store);
    expect(again.agent.id).toBe(agent.id);
  });

  it("falls back to a non-colliding name if a legacy member owns 'assistant'", async () => {
    const store = makeFakeStore();
    store.seedProject({ id: "p", orgId: "o", repoOwner: "a", repoName: "r", repoInstallationId: "i" });
    store.seedAgent({ id: "m1", projectId: "p", name: "assistant", root: "agents/assistant/agent" });
    const { agent } = await ensureAssistantAgent("p", store);
    expect(agent.name).toBe("assistant-internal");
    expect(agent.kind).toBe("assistant");
  });
});

describe("assistant instance: template hash", () => {
  it("is a stable 16-char hex of the bundled template", async () => {
    const a = await assistantTemplateHash();
    const b = await assistantTemplateHash();
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).toBe(b);
  });
});

describe("assistant instance: provisioning", () => {
  it("queues an assistant_deploy job and reports provisioning when nothing is live", async () => {
    const store = makeFakeStore();
    store.seedProject({ id: "p", orgId: "o", repoOwner: "a", repoName: "r", repoInstallationId: "i" });
    const instance = await ensureAssistantInstance("p", store);
    expect(instance.status).toBe("provisioning");
    expect(instance.deploymentId).toBeNull();
    const stats = await store.jobs.statsByStatus();
    expect((stats.queued ?? 0) >= 1).toBe(true);
  });
});
