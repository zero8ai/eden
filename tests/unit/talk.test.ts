import { afterEach, describe, expect, it, vi } from "vitest";

import { sendTurn } from "~/agent/talk.server";

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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sendTurn", () => {
  it("preserves provider failure details from failed steps", async () => {
    const at = new Date().toISOString();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ continuationToken: "tok_1" }), {
          status: 202,
          headers: {
            "content-type": "application/json",
            "x-eve-session-id": "sess_1",
          },
        }),
      )
      .mockResolvedValueOnce(
        streamResponse([
          {
            type: "session.started",
            data: { runtime: { modelId: "openrouter/z-ai/glm-5.2" } },
            meta: { at },
          },
          {
            type: "message.received",
            data: { message: "hi", turnId: "turn_1" },
            meta: { at },
          },
          {
            type: "step.started",
            data: { turnId: "turn_1", stepIndex: 0 },
            meta: { at },
          },
          {
            type: "step.failed",
            data: {
              turnId: "turn_1",
              stepIndex: 0,
              message: "Unable to make request: TypeError: fetch failed",
              code: "AI_APICallError",
              details: {
                cause: {
                  code: "ENOTFOUND",
                  hostname: "openrouter.ai",
                },
              },
            },
            meta: { at },
          },
          {
            type: "turn.failed",
            data: {
              turnId: "turn_1",
              message: "Unable to make request: TypeError: fetch failed",
            },
            meta: { at },
          },
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendTurn({
      baseUrl: "https://agent.example.test",
      message: "hi",
    });

    expect(result.ok).toBe(false);
    expect(result.modelId).toBe("openrouter/z-ai/glm-5.2");
    expect(result.error).toContain("Unable to make request");
    expect(result.error).toContain("Code: AI_APICallError");
    expect(result.error).toContain('"hostname": "openrouter.ai"');
    expect(result.steps).toMatchObject([
      {
        type: "step.failed",
        isError: true,
        code: "AI_APICallError",
        message: "Unable to make request: TypeError: fetch failed",
      },
    ]);
    expect(result.steps[0]?.details).toContain("ENOTFOUND");
  });
});
