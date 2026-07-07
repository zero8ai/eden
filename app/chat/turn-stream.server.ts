/**
 * Shared streaming-turn machinery for Eden's durable chat surfaces (playground + assistant).
 *
 * Both surfaces drive an eve turn over `streamTurn`, re-emit it to the browser as NDJSON, and —
 * critically — keep draining Eve to the terminal `done` even if the client disconnects, then
 * persist the session cursor and record the run. That disconnect-safe drain is identical for
 * both, so it lives here once. Each surface just resolves a `Target` + a `playgroundSessions`
 * row (the table is generic) and calls `streamTurnResponse`; the only difference is the
 * observability `channel`.
 */
import {
  streamTurn,
  type TurnResult,
  type TurnStep,
} from "~/agent/talk.server";
import type { Target } from "~/chat/playground.server";
import type { ChatStep } from "~/chat/types";
import {
  externalRunId,
  recordTurnFinish,
  recordTurnStart,
} from "~/observability/record.server";
import {
  savePlaygroundSessionCursor,
  savePlaygroundSessionProgress,
  type PlaygroundSession,
} from "~/playground/sessions.server";
import { syncConversationCheckout } from "~/assistant/checkout-sync.server";

/** Eve turns can run for hours; fail only after this much silence on the event stream. */
export const TURN_IDLE_TIMEOUT_MS = 5 * 60_000;

const activeTurnControllers = new Map<string, AbortController>();

export function cancelActiveTurn(playgroundSessionId: string): boolean {
  const controller = activeTurnControllers.get(playgroundSessionId);
  if (!controller) return false;
  controller.abort();
  return true;
}

/** Lean step projection sent to the browser (full actions go only to the recorder). */
export function toChatStep(step: TurnStep): ChatStep {
  return {
    type: step.type,
    name: step.name ?? null,
    durationMs: step.durationMs ?? null,
    tokensIn: step.tokensIn ?? null,
    tokensOut: step.tokensOut ?? null,
    isError: step.isError,
    code: step.code ?? null,
    message: step.message ?? null,
    details: step.details ?? null,
    toolName: step.toolName ?? null,
    summary: step.summary ?? null,
  };
}

export function asString(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value : "";
}

/**
 * Run one streaming turn against `target`, persisting into `session` (a playgroundSessions row,
 * already flipped to `running` by the caller), and return the NDJSON Response. The consume loop
 * is detached from the response lifecycle: it drains Eve to `done`, saves the cursor, and records
 * the run regardless of whether the client is still reading.
 */
export function streamTurnResponse(input: {
  projectId: string;
  target: Target;
  session: PlaygroundSession;
  message: string;
  /** Observability channel — "playground" | "assistant". */
  channel: string;
  /** Recompute the session title on the first turn (null once titled). */
  title: string | null;
  /**
   * System context prepended to what's SENT to the agent this turn (e.g. the assistant's checkout
   * path + a base-advanced note) but NOT recorded/echoed as the user's message. Optional.
   */
  messagePrefix?: string | null;
}): Response {
  const { projectId, target, session: activeSession, message, channel, title } = input;
  // What eve actually receives (prefixed with system context); recording/display use plain `message`.
  const sentMessage = input.messagePrefix ? `${input.messagePrefix}\n\n${message}` : message;
  const tag = `[${channel}]`;
  const startedAt = new Date();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let clientGone = false;
      const send = (event: Record<string, unknown>) => {
        if (clientGone) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
        } catch {
          clientGone = true;
        }
      };

      void (async () => {
        let sessionId: string | null = activeSession.externalSessionId;
        let continuationToken: string | null = activeSession.continuationToken;
        let streamIndex = activeSession.streamIndex;
        let savedSessionId: string | null = activeSession.externalSessionId;
        let savedStreamIndex = activeSession.streamIndex;
        let lastProgressSavedAt = 0;
        let progressSave: Promise<void> = Promise.resolve();
        let recorded = false;
        let startRecording: Promise<void> = Promise.resolve();
        let result: TurnResult | null = null;
        const turnController = new AbortController();
        activeTurnControllers.set(activeSession.id, turnController);

        const queueProgressSave = (force = false) => {
          if (!sessionId) return;
          const nextStreamIndex = Math.max(streamIndex, activeSession.streamIndex);
          const now = Date.now();
          const sessionChanged = sessionId !== savedSessionId;
          const advanced = nextStreamIndex > savedStreamIndex;
          if (!force && !sessionChanged && (!advanced || now - lastProgressSavedAt < 1_000)) {
            return;
          }
          const externalSessionId = sessionId;
          const nextContinuationToken = continuationToken;
          savedSessionId = externalSessionId;
          savedStreamIndex = nextStreamIndex;
          lastProgressSavedAt = now;
          progressSave = progressSave
            .catch(() => {})
            .then(() =>
              savePlaygroundSessionProgress({
                id: activeSession.id,
                target,
                externalSessionId,
                continuationToken: nextContinuationToken,
                streamIndex: nextStreamIndex,
                title,
              }).catch((e) => console.error(`${tag} persist session progress failed`, e)),
            );
        };

        try {
          for await (const event of streamTurn({
            baseUrl: target.url,
            message: sentMessage,
            sessionId,
            continuationToken: activeSession.continuationToken,
            streamIndex: activeSession.streamIndex,
            signal: turnController.signal,
            timeoutMs: TURN_IDLE_TIMEOUT_MS,
          })) {
            switch (event.kind) {
              case "session":
                sessionId = event.sessionId;
                continuationToken = event.continuationToken;
                queueProgressSave(true);
                send({
                  type: "session",
                  playgroundSessionId: activeSession.id,
                });
                break;
              case "progress":
                sessionId = event.sessionId;
                continuationToken = event.continuationToken;
                streamIndex = event.streamIndex;
                queueProgressSave();
                break;
              case "turn":
                queueProgressSave(true);
                if (!recorded && sessionId) {
                  recorded = true;
                  const runId = externalRunId(sessionId, event.turnId);
                  startRecording = recordTurnStart({
                    projectId,
                    deploymentId: target.deploymentId,
                    releaseId: target.releaseId,
                    externalRunId: runId,
                    externalSessionId: sessionId,
                    userMessage: message,
                    channel,
                  }).catch((e) => console.error(`${tag} recordTurnStart failed`, e));
                }
                break;
              case "model":
                send({ type: "model", modelId: event.modelId });
                break;
              case "thinking":
                send({ type: "thinking" });
                break;
              case "action":
                send({ type: "action", toolName: event.toolName, summary: event.summary ?? null });
                break;
              case "text":
                send({ type: "text", text: event.text });
                break;
              case "step":
                send({ type: "step", step: toChatStep(event.step) });
                break;
              case "input":
                send({ type: "input", requests: event.requests });
                break;
              case "done":
                result = event.result;
                send({
                  type: "done",
                  ok: event.result.ok,
                  playgroundSessionId: activeSession.id,
                  reply: event.result.reply,
                  structured: event.result.replyIsStructured,
                  inputRequests: event.result.inputRequests,
                  error: event.result.error,
                  modelId: event.result.modelId,
                  version: target.version,
                });
                break;
            }
          }
        } catch (error) {
          result = {
            ok: false,
            sessionId,
            continuationToken,
            streamIndex,
            reply: null,
            replyIsStructured: false,
            inputRequests: [],
            modelId: null,
            turnId: null,
            steps: [],
            messages: [],
            error: `The turn stream failed: ${(error as Error).message}`,
          };
          send({
            type: "done",
            ok: false,
            reply: null,
            structured: false,
            inputRequests: [],
            error: result.error,
            modelId: null,
            version: target.version,
          });
        } finally {
          if (activeTurnControllers.get(activeSession.id) === turnController) {
            activeTurnControllers.delete(activeSession.id);
          }
          await progressSave;
          if (result) {
            const settled: TurnResult = result;
            try {
              await savePlaygroundSessionCursor({
                id: activeSession.id,
                target,
                externalSessionId: settled.sessionId ?? activeSession.externalSessionId,
                continuationToken: settled.continuationToken ?? activeSession.continuationToken,
                streamIndex: Math.max(settled.streamIndex, activeSession.streamIndex),
                title,
                status: settled.ok ? "waiting" : "failed",
              });
            } catch (e) {
              console.error(`${tag} persist session cursor failed`, e);
            }
            if (settled.sessionId && settled.turnId) {
              try {
                await startRecording;
                await recordTurnFinish({
                  projectId,
                  deploymentId: target.deploymentId,
                  releaseId: target.releaseId,
                  externalRunId: externalRunId(settled.sessionId, settled.turnId),
                  externalSessionId: settled.sessionId,
                  result: settled,
                  userMessage: message,
                  channel,
                  startedAt,
                  wallClockMs: Date.now() - startedAt.getTime(),
                });
              } catch (e) {
                console.error(`${tag} recordTurnFinish failed`, e);
              }
            }
            // Assistant coding-agent sync: after the turn settles, mirror the
            // conversation's checkout to its PR. Runs regardless of turn success — a failed turn may
            // still have edited files; the sync hashes the tree and no-ops when nothing changed.
            if (channel === "assistant" && target.deploymentId) {
              try {
                await syncConversationCheckout({
                  projectId,
                  conversationId: activeSession.id,
                  deploymentId: target.deploymentId,
                  title: activeSession.title,
                });
              } catch (e) {
                console.error(`${tag} assistant checkout sync failed`, e);
              }
            }
          }
          try {
            controller.close();
          } catch {
            // already closed / errored — fine
          }
        }
      })();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}
