/**
 * Talk to a deployed eve instance over its HTTP session API (validated in docs/SPIKE-EVE.md):
 *   POST /eve/v1/session {message}  → 202 + x-eve-session-id + {sessionId, continuationToken}
 *   GET  /eve/v1/session/:id/stream → typed JSON event stream (session.started → turn.started →
 *        step.* → turn.completed/failed → session.waiting)
 *
 * This is the Playground's line to the agent: send one turn, read the stream until the turn
 * settles, and return the reply plus a step summary. Event payload shapes are parsed
 * defensively — the eve contract is young, so unknown shapes degrade to raw JSON rather than
 * throwing. Multi-turn continuation is attempted via continuationToken but eve may mint a new
 * session (spike follow-up); the caller surfaces the returned sessionId so that's visible.
 */

export interface TurnStep {
  type: string;
  name?: string;
  durationMs?: number;
  isError: boolean;
}

export interface TurnResult {
  ok: boolean;
  sessionId: string | null;
  continuationToken: string | null;
  /** Assistant reply text (or prettified structured output). */
  reply: string | null;
  /** True when the reply parsed as JSON — the UI renders it as code. */
  replyIsStructured: boolean;
  steps: TurnStep[];
  error: string | null;
}

/** Pull a human-readable text out of an unknown event payload, if one exists. */
function textOf(obj: unknown): string | null {
  if (typeof obj === "string") return obj;
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;
  for (const key of ["text", "content", "message", "output", "result", "reply"]) {
    const v = o[key];
    if (typeof v === "string" && v.trim()) return v;
    if (typeof v === "object" && v !== null) {
      const nested = textOf(v);
      if (nested) return nested;
    }
  }
  return null;
}

/** Send one message and wait for the turn to settle (or `timeoutMs`). */
export async function sendTurn(input: {
  baseUrl: string;
  message: string;
  continuationToken?: string | null;
  timeoutMs?: number;
}): Promise<TurnResult> {
  const base = input.baseUrl.replace(/\/+$/, "");
  const timeoutMs = input.timeoutMs ?? 90_000;
  const deadline = Date.now() + timeoutMs;

  // 1. Start (or attempt to continue) a session with the message.
  let sessionId: string | null = null;
  let continuationToken: string | null = null;
  try {
    const res = await fetch(`${base}/eve/v1/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: input.message,
        ...(input.continuationToken
          ? { continuationToken: input.continuationToken }
          : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok && res.status !== 202) {
      return {
        ok: false,
        sessionId: null,
        continuationToken: null,
        reply: null,
        replyIsStructured: false,
        steps: [],
        error: `Agent returned ${res.status} ${res.statusText} for POST /eve/v1/session.`,
      };
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    sessionId =
      res.headers.get("x-eve-session-id") ??
      (typeof body.sessionId === "string" ? body.sessionId : null);
    continuationToken =
      typeof body.continuationToken === "string" ? body.continuationToken : null;
  } catch (error) {
    return {
      ok: false,
      sessionId: null,
      continuationToken: null,
      reply: null,
      replyIsStructured: false,
      steps: [],
      error: `Couldn't reach the agent: ${(error as Error).message}`,
    };
  }
  if (!sessionId) {
    return {
      ok: false,
      sessionId: null,
      continuationToken,
      reply: null,
      replyIsStructured: false,
      steps: [],
      error: "The agent accepted the message but returned no session id.",
    };
  }

  // 2. Read the event stream until the turn settles.
  const steps: TurnStep[] = [];
  let reply: string | null = null;
  let error: string | null = null;
  try {
    const res = await fetch(`${base}/eve/v1/session/${sessionId}/stream`, {
      signal: AbortSignal.timeout(Math.max(1000, deadline - Date.now())),
    });
    if (!res.ok || !res.body) {
      throw new Error(`stream returned ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let settled = false;

    while (!settled && Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      // Events arrive as JSON objects, newline-separated (SSE-style `data:` prefixes tolerated).
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.replace(/^data:\s*/, "").trim();
        if (!line) continue;
        let evt: Record<string, unknown>;
        try {
          evt = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue; // not a JSON line — skip
        }
        const type = String(evt.type ?? evt.event ?? "");

        if (type.startsWith("step.")) {
          steps.push({
            type,
            name:
              (typeof evt.name === "string" && evt.name) ||
              (typeof evt.tool === "string" && evt.tool) ||
              (typeof evt.model === "string" && evt.model) ||
              undefined,
            durationMs: typeof evt.durationMs === "number" ? evt.durationMs : undefined,
            isError: type === "step.failed",
          });
        }
        if (type === "message.completed" || type === "turn.completed") {
          reply = textOf(evt) ?? reply;
        }
        if (type === "turn.failed" || type === "session.failed") {
          error = textOf(evt) ?? "The turn failed (no detail in the event).";
          settled = true;
        }
        if (type === "turn.completed" || type === "session.waiting") {
          settled = true;
        }
      }
    }
    reader.cancel().catch(() => {});
    if (!settled && reply === null && error === null) {
      error = `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the turn to complete.`;
    }
  } catch (streamError) {
    if (reply === null) {
      error = `Couldn't read the reply stream: ${(streamError as Error).message}`;
    }
  }

  // Structured output (a JSON reply) is fine — detect it so the UI renders it as code.
  let replyIsStructured = false;
  if (reply) {
    const t = reply.trim();
    if (t.startsWith("{") || t.startsWith("[")) {
      try {
        reply = JSON.stringify(JSON.parse(t), null, 2);
        replyIsStructured = true;
      } catch {
        // plain prose that happens to start with a brace — leave as-is
      }
    }
  }

  return {
    ok: error === null,
    sessionId,
    continuationToken,
    reply,
    replyIsStructured,
    steps,
    error,
  };
}
