/**
 * Record a Playground turn into the runs store so the Observe pillar (Runs tab) has something
 * to show for managed/local instances that don't push OTel telemetry. This is the only
 * telemetry PRODUCER in the app: Eden already consumes eve's event stream on every playground
 * turn (see agent/talk.server.ts), so we fold that same stream into `ingestRun` directly — no
 * HTTP, no ingest token (that path is for BYO instances).
 *
 * Two calls per turn:
 *   - `recordTurnStart` when the turn's id is first known → a `running` row (in-flight runs
 *     show up live in the Runs tab).
 *   - `recordTurnFinish` when it settles → an idempotent upsert (same externalRunId) carrying
 *     the completed status, summed tokens, wall-clock, and the full step list.
 *
 * Recording must NEVER break the user-facing stream — callers wrap these in try/catch. The
 * pure `turnToSteps` mapper is exported separately so the shape is unit-testable without a DB.
 */
import type { TurnResult } from "~/agent/talk.server";
import { ingestRun, type IngestPayload, type IngestStep } from "~/observability/store.server";

/**
 * eve turn ids (turn_0, turn_1, …) are only unique per session, and runs are unique per
 * (project, externalRunId) — so scope the id with the session.
 */
export function externalRunId(sessionId: string, turnId: string): string {
  return `${sessionId}:${turnId}`;
}

/**
 * Map a settled `TurnResult` into ordered ingest steps: for each agent step, one `model_call`
 * followed by one `tool_call` per action, then a final `message` step carrying a reply excerpt.
 * Pure (no DB) so it can be tested directly. Seq is monotonic from 1.
 */
export function turnToSteps(result: TurnResult): IngestStep[] {
  const steps: IngestStep[] = [];
  let seq = 1;
  for (const step of result.steps) {
    steps.push({
      seq: seq++,
      type: "model_call",
      model: result.modelId ?? undefined,
      tokensInput: step.tokensIn,
      tokensOutput: step.tokensOut,
      durationMs: step.durationMs,
      isError: step.isError,
      data: step.isError
        ? { message: step.message, code: step.code, details: step.details }
        : undefined,
    });
    for (const action of step.actions ?? []) {
      steps.push({
        seq: seq++,
        type: "tool_call",
        toolName: action.toolName,
        isError: action.isError,
        data: { summary: action.summary, exitCode: action.exitCode },
      });
    }
  }
  if (result.reply) {
    steps.push({
      seq: seq++,
      type: "message",
      data: { text: result.reply.slice(0, 2_000) },
    });
  }
  return steps;
}

/** Summed input/output tokens across all steps (undefined when nothing reported). */
function sumTokens(result: TurnResult): {
  tokensInput?: number;
  tokensOutput?: number;
} {
  let input = 0;
  let output = 0;
  let seen = false;
  for (const step of result.steps) {
    if (step.tokensIn != null) {
      input += step.tokensIn;
      seen = true;
    }
    if (step.tokensOut != null) {
      output += step.tokensOut;
      seen = true;
    }
  }
  return seen ? { tokensInput: input, tokensOutput: output } : {};
}

interface TurnIds {
  projectId: string;
  deploymentId: string;
  releaseId: string;
  externalRunId: string;
  externalSessionId: string;
}

/** A `running` run row so the turn shows in the Runs tab while it's in flight. */
export async function recordTurnStart(
  ids: TurnIds,
  now: Date = new Date(),
): Promise<void> {
  const payload: IngestPayload = {
    externalRunId: ids.externalRunId,
    deploymentId: ids.deploymentId,
    releaseId: ids.releaseId,
    channel: "playground",
    status: "running",
    startedAt: now.toISOString(),
    session: {
      externalSessionId: ids.externalSessionId,
      trigger: "playground",
      channel: "playground",
    },
  };
  await ingestRun(ids.projectId, payload);
}

/** Upsert the settled run: status, tokens, wall-clock, and the full step list. */
export async function recordTurnFinish(input: {
  projectId: string;
  deploymentId: string;
  releaseId: string;
  externalRunId: string;
  externalSessionId: string;
  result: TurnResult;
  startedAt: Date;
  wallClockMs: number;
  finishedAt?: Date;
}): Promise<void> {
  const finishedAt = input.finishedAt ?? new Date();
  const payload: IngestPayload = {
    externalRunId: input.externalRunId,
    deploymentId: input.deploymentId,
    releaseId: input.releaseId,
    channel: "playground",
    status: input.result.ok ? "completed" : "failed",
    error: input.result.error ?? undefined,
    wallClockMs: input.wallClockMs,
    startedAt: input.startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    session: {
      externalSessionId: input.externalSessionId,
      trigger: "playground",
      channel: "playground",
    },
    ...sumTokens(input.result),
    steps: turnToSteps(input.result),
  };
  await ingestRun(input.projectId, payload);
}
