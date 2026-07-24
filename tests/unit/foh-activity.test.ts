/**
 * FOH activity projection (app/foh/activity.ts) — pure merge/order/pagination over fixture
 * rows, plus the tolerance contract: null delegation runId (best-effort recording), missing
 * agents (set-null FKs), and delegation-linked-run suppression so one ask never renders as
 * two feed entries.
 */
import { describe, expect, it } from "vitest";

import {
  projectActivity,
  summarizeExchangeSteps,
  type ActivityDelegationRow,
  type ActivityDeploymentRow,
  type ActivityRunRow,
  type ActivitySessionRow,
  type ActivitySources,
} from "~/foh/activity";

const at = (iso: string) => new Date(iso);

const session = (over: Partial<ActivitySessionRow> = {}): ActivitySessionRow => ({
  id: "sess_1",
  createdAt: at("2026-07-24T10:00:00Z"),
  agentId: "agent_ivy",
  createdBy: "user_1",
  openedByAgentId: null,
  title: "fix the pricing page",
  ...over,
});

const delegation = (
  over: Partial<ActivityDelegationRow> = {},
): ActivityDelegationRow => ({
  id: "dele_1",
  startedAt: at("2026-07-24T10:44:00Z"),
  finishedAt: null,
  status: "running",
  error: null,
  fromAgentId: "agent_sam",
  toAgentId: "agent_ivy",
  runId: "run_dele",
  ...over,
});

const run = (over: Partial<ActivityRunRow> = {}): ActivityRunRow => ({
  id: "run_1",
  startedAt: at("2026-07-24T10:30:00Z"),
  status: "completed",
  channel: "foh",
  agentId: "agent_ivy",
  error: null,
  metadata: { input: "check the deploy" },
  ...over,
});

const deployment = (
  over: Partial<ActivityDeploymentRow> = {},
): ActivityDeploymentRow => ({
  id: "depl_1",
  createdAt: at("2026-07-24T09:00:00Z"),
  status: "live",
  agentId: "agent_ivy",
  version: "v3",
  ...over,
});

const AGENT_NAMES = new Map([
  ["agent_sam", "sam"],
  ["agent_ivy", "ivy"],
]);
const USER_NAMES = new Map([["user_1", "Aaron"]]);

const sources = (over: Partial<ActivitySources> = {}): ActivitySources => ({
  sessions: [],
  delegations: [],
  runs: [],
  deployments: [],
  ...over,
});

describe("projectActivity", () => {
  it("merges all four sources newest-first with resolved names", () => {
    const page = projectActivity(
      sources({
        sessions: [session()],
        delegations: [
          delegation({ status: "waiting", finishedAt: at("2026-07-24T10:45:00Z") }),
        ],
        runs: [run()],
        deployments: [deployment()],
      }),
      {
        limit: 10,
        agentNames: AGENT_NAMES,
        userNames: USER_NAMES,
        askByRunId: new Map([["run_dele", "can you check DNS?"]]),
      },
    );

    expect(page.events.map((e) => e.type)).toEqual([
      "delegation",
      "run",
      "session",
      "deployment",
    ]);
    expect(page.events[0]).toMatchObject({
      type: "delegation",
      fromAgentName: "sam",
      toAgentName: "ivy",
      ask: "can you check DNS?",
      status: "waiting",
      // waiting rows carry a park-time finishedAt (WP4) — never rendered as an outcome.
      finishedAt: null,
    });
    expect(page.events[2]).toMatchObject({
      type: "session",
      openedByUserName: "Aaron",
      openedByAgentName: null,
      agentName: "ivy",
      title: "fix the pricing page",
    });
    expect(page.nextBefore).toBeNull();
  });

  it("paginates: full page yields nextBefore = oldest event's timestamp", () => {
    const runs = Array.from({ length: 5 }, (_, i) =>
      run({
        id: `run_${i}`,
        startedAt: at(`2026-07-24T10:0${i}:00Z`),
        metadata: {},
      }),
    );
    const page = projectActivity(sources({ runs }), {
      limit: 3,
      agentNames: AGENT_NAMES,
    });
    expect(page.events).toHaveLength(3);
    expect(page.events.map((e) => e.at)).toEqual([
      "2026-07-24T10:04:00.000Z",
      "2026-07-24T10:03:00.000Z",
      "2026-07-24T10:02:00.000Z",
    ]);
    expect(page.nextBefore).toBe("2026-07-24T10:02:00.000Z");
  });

  it("suppresses delegation-linked runs so an ask is one entry, not two", () => {
    const page = projectActivity(
      sources({
        delegations: [delegation()],
        runs: [
          run({
            id: "run_dele",
            startedAt: at("2026-07-24T10:44:01Z"),
            channel: "teammate",
            metadata: { input: "can you check DNS?", delegationId: "dele_1" },
          }),
          run({ id: "run_plain", metadata: {} }),
        ],
      }),
      { limit: 10, agentNames: AGENT_NAMES },
    );
    expect(page.events.map((e) => e.type)).toEqual(["delegation", "run"]);
    expect(page.events[1]).toMatchObject({ runId: "run_plain" });
  });

  it("tolerates null runId, missing agents, and settled rows render finishedAt", () => {
    const page = projectActivity(
      sources({
        delegations: [
          delegation({
            runId: null,
            fromAgentId: null,
            status: "failed",
            error: "peer timed out",
            finishedAt: at("2026-07-24T10:50:00Z"),
          }),
        ],
        sessions: [
          session({
            id: "sess_agent",
            createdBy: null,
            openedByAgentId: "agent_gone",
            agentId: null,
            title: null,
          }),
        ],
        deployments: [deployment({ agentId: null, version: null })],
      }),
      { limit: 10, agentNames: AGENT_NAMES, userNames: USER_NAMES },
    );

    const dele = page.events.find((e) => e.type === "delegation");
    expect(dele).toMatchObject({
      ask: null,
      fromAgentName: null,
      toAgentName: "ivy",
      error: "peer timed out",
      finishedAt: "2026-07-24T10:50:00.000Z",
    });
    const sess = page.events.find((e) => e.type === "session");
    expect(sess).toMatchObject({
      openedByUserName: null,
      openedByAgentName: null, // opener agent no longer in the roster map
      agentName: null,
      title: null,
    });
    const depl = page.events.find((e) => e.type === "deployment");
    expect(depl).toMatchObject({ agentName: null, version: null });
  });

  it("orders equal timestamps deterministically", () => {
    const ts = at("2026-07-24T12:00:00Z");
    const a = projectActivity(
      sources({
        runs: [run({ id: "run_b", startedAt: ts, metadata: {} })],
        deployments: [deployment({ id: "depl_a", createdAt: ts })],
      }),
      { limit: 10, agentNames: AGENT_NAMES },
    );
    const b = projectActivity(
      sources({
        deployments: [deployment({ id: "depl_a", createdAt: ts })],
        runs: [run({ id: "run_b", startedAt: ts, metadata: {} })],
      }),
      { limit: 10, agentNames: AGENT_NAMES },
    );
    expect(a.events.map((e) => e.id)).toEqual(b.events.map((e) => e.id));
  });
});

describe("summarizeExchangeSteps", () => {
  it("keeps messages and tool calls in seq order, drops quiet model beats", () => {
    const steps = summarizeExchangeSteps([
      { seq: 3, type: "tool_call", toolName: "bash", isError: false, data: { summary: "dig eden.dev" } },
      { seq: 1, type: "message", toolName: null, isError: false, data: { role: "user", text: "can you check DNS?" } },
      { seq: 2, type: "model_call", toolName: null, isError: false, data: {} },
      { seq: 4, type: "message", toolName: null, isError: false, data: { role: "assistant", text: "DNS looks fine." } },
    ]);
    expect(steps).toEqual([
      { kind: "message", role: "user", text: "can you check DNS?" },
      { kind: "tool", toolName: "bash", summary: "dig eden.dev", isError: false },
      { kind: "message", role: "assistant", text: "DNS looks fine." },
    ]);
  });

  it("surfaces failed model beats as errors and tolerates null data", () => {
    const steps = summarizeExchangeSteps([
      { seq: 1, type: "model_call", toolName: null, isError: true, data: { message: "overloaded" } },
      { seq: 2, type: "reasoning", toolName: null, isError: false, data: null },
      { seq: 3, type: "tool_call", toolName: null, isError: true, data: null },
    ]);
    expect(steps).toEqual([
      { kind: "error", text: "overloaded" },
      { kind: "tool", toolName: null, summary: null, isError: true },
    ]);
  });
});
