/**
 * Playground streaming turn (resource route, action only). The page POSTs a message here and
 * reads back an NDJSON stream of the turn as it runs — model, thinking, tool actions, live
 * reply text, completed steps, then a terminal `done`. This is what makes long agent turns
 * (15+ min) usable: the browser sees progress instead of one spinner and a 90s timeout.
 *
 * Disconnect-safe by design: the turn-consuming loop runs to completion independent of the
 * response stream. If the client navigates away, we keep draining eve, then persist the
 * assistant reply + steps to the conversation and record the run — so the transcript and the
 * Runs tab are correct whether or not anyone was watching.
 */
import { withAuth } from "@workos-inc/authkit-react-router";
import { data, redirect, type ActionFunctionArgs } from "react-router";

import { streamTurn, type TurnResult, type TurnStep } from "~/agent/talk.server";
import {
  loadConversation,
  saveConversation,
} from "~/chat/conversation.server";
import {
  EMPTY_STATE,
  liveTargets,
  playgroundKind,
  type PlaygroundState,
} from "~/chat/playground.server";
import type { ChatEntry, ChatStep } from "~/chat/types";
import { newId } from "~/lib/id";
import {
  externalRunId,
  recordTurnFinish,
  recordTurnStart,
} from "~/observability/record.server";
import { resolveAgentContext, agentFromParams } from "~/project/agent-context.server";
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
  const agentName = agentFromParams(args.params) ?? asString(form.get("agentName"));
  const { active } = await resolveAgentContext(project.id, agentName);
  const kind = playgroundKind(active.id);

  const deploymentId = asString(form.get("deploymentId"));
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

  const conversation = await loadConversation<PlaygroundState>(
    project.id,
    kind,
    auth.user.id,
    EMPTY_STATE,
  );
  // Persist the user's message immediately so it survives a disconnect mid-turn.
  const userEntry: ChatEntry = { id: newId(), role: "user", text: message };
  const baseEntries: ChatEntry[] = [...conversation.entries, userEntry];
  // A different deployment doesn't share the eve session — keep the transcript, drop tokens.
  const sameTarget = conversation.state.deploymentId === deploymentId;
  await saveConversation(project.id, kind, auth.user.id, baseEntries, {
    deploymentId,
    sessionId: sameTarget ? conversation.state.sessionId : null,
    continuationToken: sameTarget ? conversation.state.continuationToken : null,
  } satisfies PlaygroundState);

  const userId = auth.user.id;
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
        let sessionId: string | null = sameTarget
          ? conversation.state.sessionId
          : null;
        let recorded = false;
        // Kept so the finish upsert can await it — a start that resolves late would
        // otherwise overwrite the settled run back to `running`.
        let startRecording: Promise<void> = Promise.resolve();
        let result: TurnResult | null = null;
        try {
          for await (const event of streamTurn({
            baseUrl: target.url,
            message,
            sessionId,
            continuationToken: sameTarget
              ? conversation.state.continuationToken
              : null,
            timeoutMs: TURN_TIMEOUT_MS,
          })) {
            switch (event.kind) {
              case "session":
                sessionId = event.sessionId;
                break;
              case "turn":
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
              case "done":
                result = event.result;
                send({
                  type: "done",
                  ok: event.result.ok,
                  reply: event.result.reply,
                  structured: event.result.replyIsStructured,
                  error: event.result.error,
                  modelId: event.result.modelId,
                  version: target.version,
                });
                break;
            }
          }
        } catch (error) {
          send({
            type: "done",
            ok: false,
            reply: null,
            structured: false,
            error: `The turn stream failed: ${(error as Error).message}`,
            modelId: null,
            version: target.version,
          });
        } finally {
          // Persist whatever the turn produced BEFORE closing the stream, so a client that
          // waits for stream-end can revalidate into a transcript that's already saved. This
          // runs even when the client is gone.
          if (result) {
            const settled: TurnResult = result;
            try {
              const assistant: ChatEntry = {
                id: newId(),
                role: "assistant",
                text: settled.reply ?? "",
                structured: settled.replyIsStructured,
                version: target.version,
                modelId: settled.modelId,
                steps: settled.steps.map(toChatStep),
                error: settled.error,
              };
              await saveConversation(
                project.id,
                kind,
                userId,
                [...baseEntries, assistant],
                {
                  deploymentId,
                  sessionId: settled.sessionId,
                  continuationToken: settled.continuationToken,
                } satisfies PlaygroundState,
              );
            } catch (e) {
              console.error("[playground] persist transcript failed", e);
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
