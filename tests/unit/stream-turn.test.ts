import { afterEach, describe, expect, it, vi } from "vitest";

import { streamTurn, type TalkEvent } from "~/agent/talk.server";

/** Emit the events as one NDJSON body (the eve stream shape). */
function streamResponse(events: unknown[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          events.map((event) => JSON.stringify(event)).join("\n") + "\n",
        ),
      );
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/x-ndjson" },
  });
}

function sessionStart(): Response {
  return new Response(JSON.stringify({ continuationToken: "tok_1" }), {
    status: 202,
    headers: {
      "content-type": "application/json",
      "x-eve-session-id": "sess_1",
    },
  });
}

async function drain(events: unknown[]): Promise<TalkEvent[]> {
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(sessionStart())
    .mockResolvedValueOnce(streamResponse(events));
  vi.stubGlobal("fetch", fetchMock);
  const out: TalkEvent[] = [];
  for await (const event of streamTurn({
    baseUrl: "https://agent.example.test",
    message: "hi",
  })) {
    out.push(event);
  }
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("streamTurn", () => {
  it("emits events in order with cumulative reply text, ending in done", async () => {
    const at = new Date().toISOString();
    const out = await drain([
      { type: "session.started", data: { runtime: { modelId: "m/x" } }, meta: { at } },
      { type: "message.received", data: { message: "hi", turnId: "turn_1" }, meta: { at } },
      { type: "step.started", data: { turnId: "turn_1", sequence: 1, stepIndex: 0 }, meta: { at } },
      { type: "message.appended", data: { turnId: "turn_1", messageSoFar: "Hel" }, meta: { at } },
      { type: "message.appended", data: { turnId: "turn_1", messageSoFar: "Hello" }, meta: { at } },
      { type: "message.completed", data: { turnId: "turn_1", message: "Hello" }, meta: { at } },
      { type: "step.completed", data: { turnId: "turn_1", sequence: 1, stepIndex: 0, usage: { inputTokens: 5, outputTokens: 3 } }, meta: { at } },
      { type: "turn.completed", data: { turnId: "turn_1" }, meta: { at } },
    ]);

    const kinds = out.map((e) => e.kind);
    expect(kinds[0]).toBe("session");
    expect(kinds).toContain("model");
    expect(kinds).toContain("turn");
    expect(kinds).toContain("thinking");
    expect(kinds).toContain("step");
    expect(kinds[kinds.length - 1]).toBe("done");

    const texts = out.flatMap((e) => (e.kind === "text" ? [e.text] : []));
    expect(texts).toEqual(["Hel", "Hello"]);

    const done = out.at(-1);
    expect(done?.kind === "done" && done.result.reply).toBe("Hello");
    expect(done?.kind === "done" && done.result.ok).toBe(true);
    expect(done?.kind === "done" && done.result.modelId).toBe("m/x");
  });

  it("keys step durations on sequence, not the always-zero stepIndex", async () => {
    const t0 = Date.now();
    const iso = (ms: number) => new Date(t0 + ms).toISOString();
    const out = await drain([
      { type: "message.received", data: { message: "hi", turnId: "turn_1" }, meta: { at: iso(0) } },
      { type: "step.started", data: { turnId: "turn_1", sequence: 1, stepIndex: 0 }, meta: { at: iso(0) } },
      { type: "step.completed", data: { turnId: "turn_1", sequence: 1, stepIndex: 0 }, meta: { at: iso(1000) } },
      { type: "step.started", data: { turnId: "turn_1", sequence: 2, stepIndex: 0 }, meta: { at: iso(2000) } },
      { type: "step.completed", data: { turnId: "turn_1", sequence: 2, stepIndex: 0 }, meta: { at: iso(3000) } },
      { type: "message.completed", data: { turnId: "turn_1", message: "ok" }, meta: { at: iso(3000) } },
      { type: "turn.completed", data: { turnId: "turn_1" }, meta: { at: iso(3000) } },
    ]);

    const done = out.at(-1);
    const steps = done?.kind === "done" ? done.result.steps : [];
    expect(steps).toHaveLength(2);
    expect(steps[0].durationMs).toBe(1000);
    expect(steps[1].durationMs).toBe(1000);
  });

  it("correlates actions to their step, including a failed action", async () => {
    const at = new Date().toISOString();
    const out = await drain([
      { type: "message.received", data: { message: "hi", turnId: "turn_1" }, meta: { at } },
      { type: "step.started", data: { turnId: "turn_1", sequence: 1 }, meta: { at } },
      {
        type: "actions.requested",
        data: {
          turnId: "turn_1",
          sequence: 1,
          actions: [
            { callId: "c1", toolName: "bash", input: { command: "npm test" }, kind: "tool-call" },
            { callId: "c2", toolName: "read_file", input: { path: "/etc/x" }, kind: "tool-call" },
          ],
        },
        meta: { at },
      },
      {
        type: "action.result",
        data: { turnId: "turn_1", sequence: 1, status: "completed", result: { callId: "c1", output: { exitCode: 0, stdout: "ok" } } },
        meta: { at },
      },
      {
        type: "action.result",
        data: { turnId: "turn_1", sequence: 1, status: "failed", result: { callId: "c2", output: "boom" } },
        meta: { at },
      },
      { type: "step.completed", data: { turnId: "turn_1", sequence: 1 }, meta: { at } },
      { type: "message.completed", data: { turnId: "turn_1", message: "done" }, meta: { at } },
      { type: "turn.completed", data: { turnId: "turn_1" }, meta: { at } },
    ]);

    const done = out.at(-1);
    const step = done?.kind === "done" ? done.result.steps[0] : undefined;
    expect(step?.toolName).toBe("bash");
    expect(step?.summary).toBe("npm test");
    expect(step?.actions).toMatchObject([
      { toolName: "bash", summary: "npm test", exitCode: 0, isError: false },
      { toolName: "read_file", summary: "/etc/x", isError: true },
    ]);

    // The live activity stream carries each requested action.
    const actions = out.flatMap((e) =>
      e.kind === "action" ? [`${e.toolName}:${e.summary}`] : [],
    );
    expect(actions).toEqual(["bash:npm test", "read_file:/etc/x"]);
  });

  it("surfaces the eve turnId on the turn event and the result", async () => {
    const at = new Date().toISOString();
    const out = await drain([
      { type: "message.received", data: { message: "hi", turnId: "turn_1" }, meta: { at } },
      { type: "message.completed", data: { turnId: "turn_1", message: "hi back" }, meta: { at } },
      { type: "turn.completed", data: { turnId: "turn_1" }, meta: { at } },
    ]);
    const turn = out.find((e) => e.kind === "turn");
    expect(turn?.kind === "turn" && turn.turnId).toBe("turn_1");
    const done = out.at(-1);
    expect(done?.kind === "done" && done.result.turnId).toBe("turn_1");
  });

  it("skips replayed history and attributes only our turn", async () => {
    const now = Date.now();
    const old = new Date(now - 5 * 60_000).toISOString(); // well before postedAt
    const fresh = new Date(now).toISOString();
    const out = await drain([
      // Replayed previous turn — same text, but old, and a different turnId.
      { type: "message.received", data: { message: "hi", turnId: "turn_0" }, meta: { at: old } },
      { type: "step.completed", data: { turnId: "turn_0", sequence: 1 }, meta: { at: old } },
      { type: "turn.completed", data: { turnId: "turn_0" }, meta: { at: old } },
      // Our turn.
      { type: "message.received", data: { message: "hi", turnId: "turn_1" }, meta: { at: fresh } },
      { type: "step.completed", data: { turnId: "turn_1", sequence: 1 }, meta: { at: fresh } },
      { type: "message.completed", data: { turnId: "turn_1", message: "our reply" }, meta: { at: fresh } },
      { type: "turn.completed", data: { turnId: "turn_1" }, meta: { at: fresh } },
    ]);

    const done = out.at(-1);
    expect(done?.kind === "done" && done.result.turnId).toBe("turn_1");
    expect(done?.kind === "done" && done.result.reply).toBe("our reply");
    // Only our turn's single step counts — the replayed turn_0 step is ignored.
    expect(done?.kind === "done" && done.result.steps).toHaveLength(1);
  });
});
