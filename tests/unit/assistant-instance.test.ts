import { describe, expect, it } from "vitest";

import {
  assistantTemplateHash,
  ensureAssistantAgent,
  ensureAssistantInstance,
  peekAssistantInstance,
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
  it("persists a pending deployment, queues assistant_deploy, and reports provisioning", async () => {
    const store = makeFakeStore();
    store.seedProject({ id: "p", orgId: "o", repoOwner: "a", repoName: "r", repoInstallationId: "i" });
    const instance = await ensureAssistantInstance("p", store);
    expect(instance.status).toBe("provisioning");
    // The `pending` row is created synchronously (#17): a loader re-read right after the provision
    // click must already see "provisioning" instead of racing the async worker.
    expect(instance.deploymentId).not.toBeNull();
    const snapshot = await peekAssistantInstance("p", store);
    expect(snapshot.status).toBe("provisioning");
    const stats = await store.jobs.statsByStatus();
    expect((stats.queued ?? 0) >= 1).toBe(true);
  });

  it("does not enqueue a second deploy while one is already pending", async () => {
    const store = makeFakeStore();
    store.seedProject({ id: "p", orgId: "o", repoOwner: "a", repoName: "r", repoInstallationId: "i" });
    const first = await ensureAssistantInstance("p", store);
    const second = await ensureAssistantInstance("p", store);
    // The second call finds the pending row and returns it — no duplicate row, no duplicate job.
    expect(second.deploymentId).toBe(first.deploymentId);
    const stats = await store.jobs.statsByStatus();
    expect(stats.queued ?? 0).toBe(1);
  });
});
