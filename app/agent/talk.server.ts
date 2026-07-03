/**
 * Talk to a deployed eve instance over its HTTP session API (contract verified live 2026-07-03
 * against a running instance; see docs/SPIKE-EVE.md):
 *
 *   First turn:  POST /eve/v1/session              {message}
 *                → 202 + x-eve-session-id + {sessionId, continuationToken}
 *   Follow-ups:  POST /eve/v1/session/:sessionId   {message, continuationToken}
 *                → same session, context retained (the token stays valid for the session)
 *   Events:      GET  /eve/v1/session/:id/stream   — NDJSON {type, data, meta.at}:
 *                session.started (runtime.modelId) → turn.started → message.received →
 *                step.started → message.appended (messageSoFar) → message.completed
 *                (data.message = full reply) → step.completed (data.usage tokens) →
 *                turn.completed → session.waiting
 *
 * IMPORTANT: the stream REPLAYS the session's whole history on connect, so a follow-up turn
 * must attribute events to OUR turn (matched by message text + a post-time timestamp guard)
 * rather than settling on the first replayed turn.completed.
 */

export interface TurnStep {
  type: string;
  name?: string;
  durationMs?: number;
  tokensIn?: number;
  tokensOut?: number;
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
  /** Model that served the turn (from session.started runtime metadata). */
  modelId: string | null;
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
  /** Both present → follow-up turn on the existing session (context retained). */
  sessionId?: string | null;
  continuationToken?: string | null;
  timeoutMs?: number;
}): Promise<TurnResult> {
  const base = input.baseUrl.replace(/\/+$/, "");
  const timeoutMs = input.timeoutMs ?? 90_000;
  const deadline = Date.now() + timeoutMs;
  // Events older than this are history replay, not our turn (same-box clocks; generous skew).
  const postedAt = Date.now() - 30_000;
  const isFollowUp = !!(input.sessionId && input.continuationToken);

  // 1. Start a session with the message — or continue the existing one.
  let sessionId: string | null = null;
  let continuationToken: string | null = null;
  try {
    const res = await fetch(
      isFollowUp
        ? `${base}/eve/v1/session/${input.sessionId}`
        : `${base}/eve/v1/session`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: input.message,
          ...(isFollowUp ? { continuationToken: input.continuationToken } : {}),
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!res.ok && res.status !== 202) {
      return {
        ok: false,
        sessionId: null,
        continuationToken: null,
        reply: null,
        replyIsStructured: false,
        modelId: null,
        steps: [],
        error: `Agent returned ${res.status} ${res.statusText} for POST /eve/v1/session.`,
      };
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    sessionId =
      res.headers.get("x-eve-session-id") ??
      (typeof body.sessionId === "string" ? body.sessionId : null);
    // Follow-up responses omit the token — it stays valid for the whole session.
    continuationToken =
      typeof body.continuationToken === "string"
        ? body.continuationToken
        : (input.continuationToken ?? null);
  } catch (error) {
    return {
      ok: false,
      sessionId: null,
      continuationToken: null,
      reply: null,
      replyIsStructured: false,
      modelId: null,
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
      modelId: null,
      steps: [],
      error: "The agent accepted the message but returned no session id.",
    };
  }

  // 2. Read the event stream until the turn settles.
  const steps: TurnStep[] = [];
  let reply: string | null = null;
  let error: string | null = null;
  let modelId: string | null = null;
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
    // step.started timestamps by stepIndex, to compute durations at step.completed.
    const stepStarts = new Map<number, number>();
    // The stream replays session history — only events belonging to OUR turn count. We learn
    // our turnId from the message.received that matches our text at a recent timestamp.
    let ourTurnId: string | null = null;

    while (!settled && Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      // NDJSON events, one per line: {"type": "...", "data": {...}, "meta": {"at": ISO}}.
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.replace(/^data:\s*/, "").trim();
        if (!line) continue;
        let evt: {
          type?: string;
          data?: Record<string, unknown>;
          meta?: { at?: string };
        };
        try {
          evt = JSON.parse(line);
        } catch {
          continue; // not a JSON line — skip
        }
        const type = String(evt.type ?? "");
        const data = evt.data ?? {};
        const at = evt.meta?.at ? Date.parse(evt.meta.at) : Date.now();
        const stepIndex = typeof data.stepIndex === "number" ? data.stepIndex : 0;
        const turnId = typeof data.turnId === "string" ? data.turnId : null;
        const ours = ourTurnId !== null && turnId === ourTurnId;

        switch (type) {
          case "session.started": {
            const runtime = data.runtime as Record<string, unknown> | undefined;
            if (runtime && typeof runtime.modelId === "string") modelId = runtime.modelId;
            break;
          }
          case "message.received":
            // Our turn = the (latest) received message matching what we just sent, at a
            // timestamp after we posted — replayed history is older and is skipped.
            if (data.message === input.message && at >= postedAt) {
              ourTurnId = turnId;
            }
            break;
          case "step.started":
            if (ours) stepStarts.set(stepIndex, at);
            break;
          case "step.completed":
          case "step.failed": {
            if (!ours) break;
            const usage = data.usage as Record<string, unknown> | undefined;
            const started = stepStarts.get(stepIndex);
            steps.push({
              type,
              durationMs: started != null ? Math.max(0, at - started) : undefined,
              tokensIn: usage && typeof usage.inputTokens === "number" ? usage.inputTokens : undefined,
              tokensOut: usage && typeof usage.outputTokens === "number" ? usage.outputTokens : undefined,
              isError: type === "step.failed",
            });
            break;
          }
          case "message.completed":
            // The full reply text: data.message (streamed earlier via message.appended).
            if (ours) {
              reply = typeof data.message === "string" ? data.message : (textOf(data) ?? reply);
            }
            break;
          case "turn.failed":
          case "session.failed":
            if (ours || type === "session.failed") {
              error = textOf(data) ?? "The turn failed (no detail in the event).";
              settled = true;
            }
            break;
          case "turn.completed":
            if (ours) settled = true;
            break;
          case "session.waiting":
            // Only trust a waiting marker once our turn produced a reply — earlier ones are
            // history replay from previous turns.
            if (ourTurnId !== null && (reply !== null || error !== null)) settled = true;
            break;
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
    modelId,
    steps,
    error,
  };
}
