import { describe, expect, it } from "vitest";

import type { TurnResult } from "~/agent/talk.server";
import { externalRunId, turnToSteps } from "~/observability/record.server";

function result(over: Partial<TurnResult> = {}): TurnResult {
  return {
    ok: true,
    sessionId: "sess_1",
    continuationToken: "tok_1",
    streamIndex: 0,
    reply: "all done",
    replyIsStructured: false,
    modelId: "m/x",
    turnId: "turn_1",
    steps: [],
    error: null,
    ...over,
  };
}

describe("externalRunId", () => {
  it("scopes the per-session turn id with the session", () => {
    expect(externalRunId("sess_1", "turn_1")).toBe("sess_1:turn_1");
  });
});

describe("turnToSteps", () => {
  it("maps each step to a model_call, one tool_call per action, then a final message", () => {
    const steps = turnToSteps(
      result({
        steps: [
          {
            type: "step.completed",
            durationMs: 1200,
            tokensIn: 10,
            tokensOut: 4,
            isError: false,
            toolName: "bash",
            summary: "npm test",
            actions: [
              { toolName: "bash", summary: "npm test", exitCode: 0, isError: false },
              { toolName: "read_file", summary: "/x", isError: true },
            ],
          },
        ],
      }),
    );

    expect(steps.map((s) => [s.seq, s.type])).toEqual([
      [1, "model_call"],
      [2, "tool_call"],
      [3, "tool_call"],
      [4, "message"],
    ]);
    expect(steps[0]).toMatchObject({
      type: "model_call",
      model: "m/x",
      tokensInput: 10,
      tokensOutput: 4,
      durationMs: 1200,
      isError: false,
    });
    expect(steps[1]).toMatchObject({
      type: "tool_call",
      toolName: "bash",
      isError: false,
      data: { summary: "npm test", exitCode: 0 },
    });
    expect(steps[2]).toMatchObject({ type: "tool_call", toolName: "read_file", isError: true });
    expect(steps[3]).toMatchObject({ type: "message", data: { text: "all done" } });
  });

  it("carries failure detail on a failed model_call and omits the message step with no reply", () => {
    const steps = turnToSteps(
      result({
        ok: false,
        reply: null,
        error: "boom",
        steps: [
          {
            type: "step.failed",
            isError: true,
            code: "AI_APICallError",
            message: "fetch failed",
            details: "ENOTFOUND",
          },
        ],
      }),
    );

    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      type: "model_call",
      isError: true,
      data: { message: "fetch failed", code: "AI_APICallError", details: "ENOTFOUND" },
    });
  });

  it("truncates a long reply excerpt to 2000 chars", () => {
    const steps = turnToSteps(result({ reply: "x".repeat(5000) }));
    const message = steps.find((s) => s.type === "message");
    expect((message?.data?.text as string).length).toBe(2000);
  });
});
