import { describe, expect, it } from "vitest";

import type { TurnResult } from "~/agent/talk.server";
import { FIELD_CAP } from "~/observability/capture.server";
import { externalRunId, turnToSteps } from "~/observability/record.server";

function result(over: Partial<TurnResult> = {}): TurnResult {
  return {
    ok: true,
    sessionId: "sess_1",
    continuationToken: "tok_1",
    streamIndex: 0,
    reply: "all done",
    replyIsStructured: false,
    inputRequests: [],
    modelId: "m/x",
    turnId: "turn_1",
    steps: [],
    messages: [],
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
              {
                toolName: "bash",
                summary: "npm test",
                exitCode: 0,
                isError: false,
                input: { command: "npm test" },
                output: { stdout: "ok", exitCode: 0 },
              },
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
    // tool_call now carries the FULL input/output, not just a summary.
    expect(steps[1]).toMatchObject({
      type: "tool_call",
      toolName: "bash",
      isError: false,
      data: {
        input: { command: "npm test" },
        output: { stdout: "ok", exitCode: 0 },
        summary: "npm test",
        exitCode: 0,
      },
    });
    expect(steps[2]).toMatchObject({ type: "tool_call", toolName: "read_file", isError: true });
    // The final assistant reply is a message step with an explicit role.
    expect(steps[3]).toMatchObject({
      type: "message",
      data: { role: "assistant", text: "all done" },
    });
  });

  it("emits a leading user message step when the triggering input is supplied", () => {
    const steps = turnToSteps(result(), { userMessage: "do the thing" });
    expect(steps[0]).toMatchObject({
      seq: 1,
      type: "message",
      data: { role: "user", text: "do the thing" },
    });
    // reply becomes the trailing assistant message
    expect(steps.at(-1)).toMatchObject({
      type: "message",
      data: { role: "assistant", text: "all done" },
    });
  });

  it("interleaves assistant messages between tool steps by afterStepIndex", () => {
    const steps = turnToSteps(
      result({
        reply: "before\n\nafter",
        messages: [
          { afterStepIndex: 0, text: "before" },
          { afterStepIndex: 1, text: "after" },
        ],
        steps: [
          {
            type: "step.completed",
            isError: false,
            actions: [{ toolName: "bash", isError: false }],
          },
        ],
      }),
    );
    expect(steps.map((s) => s.type)).toEqual([
      "message", // "before" (afterStepIndex 0)
      "model_call",
      "tool_call",
      "message", // "after" (afterStepIndex 1)
    ]);
    expect(steps[0]).toMatchObject({ data: { role: "assistant", text: "before" } });
    expect(steps[3]).toMatchObject({ data: { role: "assistant", text: "after" } });
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

  it("caps a long reply at FIELD_CAP and marks it truncated", () => {
    const steps = turnToSteps(result({ reply: "x".repeat(FIELD_CAP + 5000) }));
    const message = steps.find((s) => s.type === "message");
    expect((message?.data?.text as string).length).toBe(FIELD_CAP);
    expect(message?.data?.truncated).toBe(true);
  });

  it("caps oversized tool input and flags truncation", () => {
    const steps = turnToSteps(
      result({
        reply: null,
        steps: [
          {
            type: "step.completed",
            isError: false,
            actions: [
              {
                toolName: "bash",
                isError: false,
                input: { command: "y".repeat(FIELD_CAP + 100) },
              },
            ],
          },
        ],
      }),
    );
    const tool = steps.find((s) => s.type === "tool_call");
    expect(((tool?.data?.input as { command: string }).command).length).toBe(FIELD_CAP);
    expect(tool?.data?.truncated).toBe(true);
  });
});
