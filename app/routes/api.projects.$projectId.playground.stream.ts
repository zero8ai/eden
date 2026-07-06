/**
 * Playground streaming turn (resource route, action only). The page POSTs a message here and
 * reads back an NDJSON stream of the turn as it runs — model, thinking, tool actions, live
 * reply text, completed steps, then a terminal `done`. This is what makes long agent turns
 * (15+ min) usable: the browser sees progress instead of one spinner and a 90s timeout.
 *
 * Disconnect-safe by design: the turn-consuming loop runs to completion independent of the
 * response stream. If the client navigates away, we keep draining Eve, then persist the
 * session cursor and record the run — the transcript is reloaded from Eve's durable event
 * stream rather than copied into Eden.
 */
import { withAuth } from "@workos-inc/authkit-react-router";
import { data, redirect, type ActionFunctionArgs } from "react-router";

import {
  streamTurn,
  type TurnResult,
  type TurnStep,
} from "~/agent/talk.server";
import { liveTargets } from "~/chat/playground.server";
import type { ChatStep } from "~/chat/types";
import {
  externalRunId,
  recordTurnFinish,
  recordTurnStart,
} from "~/observability/record.server";
import {
  createPlaygroundSession,
  getPlaygroundSession,
  markPlaygroundSessionRunning,
  savePlaygroundSessionCursor,
  savePlaygroundSessionProgress,
  titleFromMessage,
  type PlaygroundSession,
} from "~/playground/sessions.server";
import {
  resolveAgentContext,
  agentFromParams,
} from "~/project/agent-context.server";
import { requireProject, requireRepo } from "~/project/guard.server";

/** eve turns can run for many minutes — give the stream a long leash (30 min). */
const TURN_TIMEOUT_MS = 30 * 60_000;

function toChatStep(step: TurnStep): ChatStep {
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

export async function action(args: ActionFunctionArgs) {
  const auth = await withAuth(args);
  if (!auth.user) throw redirect("/login");
  const project = requireRepo(
    await requireProject(
      {
        user: auth.user,
        organizationId: auth.organizationId ?? null,
        role: auth.role ?? null,
      },
      args.params.projectId,
    ),
  );
  const form = await args.request.formData();
  const agentName =
    agentFromParams(args.params) ?? asString(form.get("agentName"));
  const { active } = await resolveAgentContext(project.id, agentName);

  const deploymentId = asString(form.get("deploymentId"));
  const playgroundSessionId = asString(form.get("playgroundSessionId")) || null;
  const message = asString(form.get("message")).trim();
  if (!message) throw data({ error: "Type a message first." }, { status: 400 });

  // Only talk to live deployments that belong to THIS agent (tenancy guard) — reject with
  // JSON, not a stream, so the client can surface it.
  const targets = await liveTargets(active.id);
  const target = targets.find((t) => t.deploymentId === deploymentId);
  if (!target) {
    throw data(
      {
        error:
          "That deployment isn't live (or isn't part of this agent). Deploy first.",
      },
      { status: 400 },
    );
  }

  let playgroundSession: PlaygroundSession | null = playgroundSessionId
    ? await getPlaygroundSession({
        id: playgroundSessionId,
        projectId: project.id,
        agentId: active.id,
        userId: auth.user.id,
      })
    : null;
  if (playgroundSessionId && !playgroundSession) {
    throw data(
      { error: "That playground session was not found." },
      { status: 404 },
    );
  }
  if (
    playgroundSession?.externalSessionId &&
    playgroundSession.environmentId &&
    playgroundSession.environmentId !== target.environmentId
  ) {
    throw data(
      {
        error:
          "That Eve session belongs to a different environment. Start a new conversation for this deployment.",
      },
      { status: 400 },
    );
  }
  const title = playgroundSession?.title ? null : titleFromMessage(message);
  if (!playgroundSession) {
    playgroundSession = await createPlaygroundSession({
      projectId: project.id,
      agentId: active.id,
      userId: auth.user.id,
      environmentId: target.environmentId,
      deploymentId: target.deploymentId,
      releaseId: target.releaseId,
      version: target.version,
      title,
    });
  }
  await markPlaygroundSessionRunning({
    id: playgroundSession.id,
    target,
    title,
  });
  const activeSession = playgroundSession;

  const startedAt = new Date();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let clientGone = false;
      // Guarded enqueue: once the client is gone we stop writing but keep consuming.
      const send = (event: Record<string, unknown>) => {
        if (clientGone) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
        } catch {
          clientGone = true;
        }
      };

      // The consume loop is deliberately detached from the request lifecycle: it runs to the
      // terminal `done` regardless of whether anyone is still reading.
      void (async () => {
        let sessionId: string | null = activeSession.externalSessionId;
        let continuationToken: string | null = activeSession.continuationToken;
        let streamIndex = activeSession.streamIndex;
        let savedSessionId: string | null = activeSession.externalSessionId;
        let savedStreamIndex = activeSession.streamIndex;
        let lastProgressSavedAt = 0;
        let progressSave: Promise<void> = Promise.resolve();
        let recorded = false;
        // Kept so the finish upsert can await it — a start that resolves late would
        // otherwise overwrite the settled run back to `running`.
        let startRecording: Promise<void> = Promise.resolve();
        let result: TurnResult | null = null;

        const queueProgressSave = (force = false) => {
          if (!sessionId) return;
          const nextStreamIndex = Math.max(
            streamIndex,
            activeSession.streamIndex,
          );
          const now = Date.now();
          const sessionChanged = sessionId !== savedSessionId;
          const advanced = nextStreamIndex > savedStreamIndex;
          if (
            !force &&
            !sessionChanged &&
            (!advanced || now - lastProgressSavedAt < 1_000)
          ) {
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
              }).catch((e) =>
                console.error(
                  "[playground] persist session progress failed",
                  e,
                ),
              ),
            );
        };

        try {
          for await (const event of streamTurn({
            baseUrl: target.url,
            message,
            sessionId,
            continuationToken: activeSession.continuationToken,
            streamIndex: activeSession.streamIndex,
            timeoutMs: TURN_TIMEOUT_MS,
          })) {
            switch (event.kind) {
              case "session":
                sessionId = event.sessionId;
                continuationToken = event.continuationToken;
                queueProgressSave(true);
                break;
              case "progress":
                sessionId = event.sessionId;
                continuationToken = event.continuationToken;
                streamIndex = event.streamIndex;
                queueProgressSave();
                break;
              case "turn":
                queueProgressSave(true);
                // Both ids known — publish a `running` row for the Runs tab.
                if (!recorded && sessionId) {
                  recorded = true;
                  const runId = externalRunId(sessionId, event.turnId);
                  startRecording = recordTurnStart({
                    projectId: project.id,
                    deploymentId: target.deploymentId,
                    releaseId: target.releaseId,
                    externalRunId: runId,
                    externalSessionId: sessionId,
                  }).catch((e) =>
                    console.error("[playground] recordTurnStart failed", e),
                  );
                }
                break;
              case "model":
                send({ type: "model", modelId: event.modelId });
                break;
              case "thinking":
                send({ type: "thinking" });
                break;
              case "action":
                send({
                  type: "action",
                  toolName: event.toolName,
                  summary: event.summary ?? null,
                });
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
          await progressSave;
          // Persist the cursor BEFORE closing the stream, so a client that waits for
          // stream-end can revalidate into Eve history that's ready to replay.
          if (result) {
            const settled: TurnResult = result;
            try {
              await savePlaygroundSessionCursor({
                id: activeSession.id,
                target,
                externalSessionId:
                  settled.sessionId ?? activeSession.externalSessionId,
                continuationToken:
                  settled.continuationToken ?? activeSession.continuationToken,
                streamIndex: Math.max(
                  settled.streamIndex,
                  activeSession.streamIndex,
                ),
                title,
                status: settled.ok ? "waiting" : "failed",
              });
            } catch (e) {
              console.error("[playground] persist session cursor failed", e);
            }
            if (settled.sessionId && settled.turnId) {
              try {
                await startRecording;
                await recordTurnFinish({
                  projectId: project.id,
                  deploymentId: target.deploymentId,
                  releaseId: target.releaseId,
                  externalRunId: externalRunId(
                    settled.sessionId,
                    settled.turnId,
                  ),
                  externalSessionId: settled.sessionId,
                  result: settled,
                  startedAt,
                  wallClockMs: Date.now() - startedAt.getTime(),
                });
              } catch (e) {
                console.error("[playground] recordTurnFinish failed", e);
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

function asString(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value : "";
}
