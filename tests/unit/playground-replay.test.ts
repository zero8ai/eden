import { afterEach, describe, expect, it, vi } from "vitest";

import {
  loadPlaygroundEntriesFromEve,
  type PlaygroundSession,
} from "~/playground/sessions.server";
import type { Target } from "~/chat/playground.server";

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

const target: Target = {
  deploymentId: "dep_1",
  environmentId: "env_1",
  releaseId: "rel_1",
  url: "https://agent.example.test",
  version: "v1",
  environmentName: "production",
};

function session(over: Partial<PlaygroundSession> = {}): PlaygroundSession {
  return {
    externalSessionId: "sess_1",
    streamIndex: 100,
    lastVersion: "v1",
    ...over,
  } as PlaygroundSession;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadPlaygroundEntriesFromEve", () => {
  it("replays a running turn from the saved Eve cursor", async () => {
    const at = new Date().toISOString();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValueOnce(
        streamResponse([
          {
            type: "session.started",
            data: { runtime: { modelId: "m/x" } },
            meta: { at },
          },
          { type: "turn.started", data: { turnId: "turn_0" }, meta: { at } },
          {
            type: "message.received",
            data: { turnId: "turn_0", message: "finish the deploy" },
            meta: { at },
          },
          {
            type: "step.started",
            data: { turnId: "turn_0", sequence: 1 },
            meta: { at },
          },
          {
            type: "message.appended",
            data: { turnId: "turn_0", messageSoFar: "Working on it" },
            meta: { at },
          },
        ]),
      ),
    );

    const entries = await loadPlaygroundEntriesFromEve({
      session: session({ status: "running", streamIndex: 5 }),
      target,
    });

    expect(entries).toMatchObject([
      { role: "user", text: "finish the deploy" },
      {
        role: "assistant",
        text: "Working on it",
        modelId: "m/x",
      },
    ]);
  });

  it("keeps every assistant message of a turn and surfaces ask_question prompts", async () => {
    const at = new Date().toISOString();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValueOnce(
        streamResponse([
          {
            type: "session.started",
            data: { runtime: { modelId: "m/x" } },
            meta: { at },
          },
          { type: "turn.started", data: { turnId: "turn_0" }, meta: { at } },
          {
            type: "message.received",
            data: { turnId: "turn_0", message: "deploy the landing page" },
            meta: { at },
          },
          {
            type: "message.completed",
            data: { turnId: "turn_0", message: "Checking access." },
            meta: { at },
          },
          {
            type: "step.started",
            data: { turnId: "turn_0", sequence: 1 },
            meta: { at },
          },
          {
            type: "step.completed",
            data: { turnId: "turn_0", sequence: 1 },
            meta: { at },
          },
          {
            type: "message.appended",
            data: { turnId: "turn_0", messageSoFar: "One decision for you:" },
            meta: { at },
          },
          {
            type: "message.completed",
            data: { turnId: "turn_0", message: "One decision for you:" },
            meta: { at },
          },
          {
            type: "input.requested",
            data: {
              turnId: "turn_0",
              requests: [
                {
                  requestId: "r1",
                  display: "select",
                  prompt: "Merge now or wait for review?",
                  options: [
                    { id: "merge", label: "Merge now", style: "primary" },
                    { id: "wait", label: "Wait for review" },
                  ],
                  action: {
                    callId: "r1",
                    kind: "tool-call",
                    toolName: "ask_question",
                    input: { prompt: "Merge now or wait for review?" },
                  },
                },
              ],
            },
            meta: { at },
          },
          { type: "turn.completed", data: { turnId: "turn_0" }, meta: { at } },
          { type: "session.waiting", data: {}, meta: { at } },
        ]),
      ),
    );

    const entries = await loadPlaygroundEntriesFromEve({
      session: session({ streamIndex: 11 }),
      target,
    });

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      role: "user",
      text: "deploy the landing page",
    });
    expect(entries[1]).toMatchObject({
      role: "assistant",
      text: "Checking access.\n\nOne decision for you:",
      inputRequests: [
        {
          requestId: "r1",
          prompt: "Merge now or wait for review?",
          display: "select",
          options: [
            { id: "merge", label: "Merge now", style: "primary" },
            { id: "wait", label: "Wait for review" },
          ],
        },
      ],
    });
    expect(entries[1].steps).toHaveLength(1);
  });
});
