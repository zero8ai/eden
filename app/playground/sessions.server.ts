import { and, desc, eq } from "drizzle-orm";

import { inputRequestsOf } from "~/agent/talk.server";
import type { ChatEntry, ChatInputRequest, ChatStep } from "~/chat/types";
import { db } from "~/db/client.server";
import { playgroundSessions } from "~/db/schema";
import type { Target } from "~/chat/playground.server";

export type PlaygroundSession = typeof playgroundSessions.$inferSelect;

export interface PlaygroundSessionSummary {
  id: string;
  title: string;
  status: string;
  environmentId: string | null;
  updatedAt: string;
}

export function summarizePlaygroundSession(
  session: PlaygroundSession,
): PlaygroundSessionSummary {
  return {
    id: session.id,
    title: session.title ?? "New conversation",
    status: session.status,
    environmentId: session.environmentId,
    updatedAt: session.updatedAt.toISOString(),
  };
}

export async function listPlaygroundSessions(input: {
  projectId: string;
  agentId: string;
  userId: string;
}): Promise<PlaygroundSession[]> {
  return db
    .select()
    .from(playgroundSessions)
    .where(
      and(
        eq(playgroundSessions.projectId, input.projectId),
        eq(playgroundSessions.agentId, input.agentId),
        eq(playgroundSessions.createdBy, input.userId),
      ),
    )
    .orderBy(desc(playgroundSessions.updatedAt), desc(playgroundSessions.createdAt));
}

export async function getPlaygroundSession(input: {
  id: string;
  projectId: string;
  agentId: string;
  userId: string;
}): Promise<PlaygroundSession | null> {
  const [row] = await db
    .select()
    .from(playgroundSessions)
    .where(
      and(
        eq(playgroundSessions.id, input.id),
        eq(playgroundSessions.projectId, input.projectId),
        eq(playgroundSessions.agentId, input.agentId),
        eq(playgroundSessions.createdBy, input.userId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function createPlaygroundSession(input: {
  projectId: string;
  agentId: string;
  userId: string;
  environmentId?: string | null;
  deploymentId?: string | null;
  releaseId?: string | null;
  version?: string | null;
  title?: string | null;
}): Promise<PlaygroundSession> {
  const [row] = await db
    .insert(playgroundSessions)
    .values({
      projectId: input.projectId,
      agentId: input.agentId,
      createdBy: input.userId,
      environmentId: input.environmentId ?? null,
      worldKey: input.environmentId ?? null,
      lastDeploymentId: input.deploymentId ?? null,
      lastReleaseId: input.releaseId ?? null,
      lastVersion: input.version ?? null,
      title: input.title ?? null,
    })
    .returning();
  return row;
}

export async function markPlaygroundSessionRunning(input: {
  id: string;
  target: Target;
  title?: string | null;
}): Promise<void> {
  await db
    .update(playgroundSessions)
    .set({
      environmentId: input.target.environmentId,
      worldKey: input.target.environmentId,
      lastDeploymentId: input.target.deploymentId,
      lastReleaseId: input.target.releaseId,
      lastVersion: input.target.version,
      title: input.title ?? undefined,
      status: "running",
      updatedAt: new Date(),
    })
    .where(eq(playgroundSessions.id, input.id));
}

export async function savePlaygroundSessionCursor(input: {
  id: string;
  target: Target;
  externalSessionId: string | null;
  continuationToken: string | null;
  streamIndex: number;
  title?: string | null;
  status: "waiting" | "completed" | "failed";
}): Promise<void> {
  await db
    .update(playgroundSessions)
    .set({
      environmentId: input.target.environmentId,
      worldKey: input.target.environmentId,
      externalSessionId: input.externalSessionId,
      continuationToken: input.continuationToken,
      streamIndex: input.streamIndex,
      lastDeploymentId: input.target.deploymentId,
      lastReleaseId: input.target.releaseId,
      lastVersion: input.target.version,
      title: input.title ?? undefined,
      status: input.status,
      lastEventAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(playgroundSessions.id, input.id));
}

export function titleFromMessage(message: string): string {
  const collapsed = message.replace(/\s+/g, " ").trim();
  if (collapsed.length <= 80) return collapsed || "New conversation";
  return `${collapsed.slice(0, 79)}…`;
}

export async function loadPlaygroundEntriesFromEve(input: {
  session: PlaygroundSession;
  target: Target;
  timeoutMs?: number;
}): Promise<ChatEntry[]> {
  if (!input.session.externalSessionId || input.session.streamIndex <= 0) {
    return [];
  }
  const events = await readEveSessionEvents({
    baseUrl: input.target.url,
    limit: input.session.streamIndex,
    sessionId: input.session.externalSessionId,
    timeoutMs: input.timeoutMs,
  });
  return projectEventsToEntries(events, input.session);
}

interface EveStreamEvent {
  type: string;
  data: Record<string, unknown>;
  meta?: { at?: string };
}

async function readEveSessionEvents(input: {
  baseUrl: string;
  sessionId: string;
  limit: number;
  timeoutMs?: number;
}): Promise<EveStreamEvent[]> {
  const base = input.baseUrl.replace(/\/+$/, "");
  const timeoutMs = input.timeoutMs ?? 15_000;
  const res = await fetch(
    `${base}/eve/v1/session/${input.sessionId}/stream?startIndex=0`,
    { signal: AbortSignal.timeout(timeoutMs) },
  );
  if (!res.ok || !res.body) {
    throw new Error(`Eve stream returned ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events: EveStreamEvent[] = [];
  let buf = "";
  try {
    while (events.length < input.limit) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const raw of lines) {
        if (events.length >= input.limit) break;
        const event = parseEveLine(raw);
        if (event) events.push(event);
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return events;
}

function parseEveLine(raw: string): EveStreamEvent | null {
  const line = raw.replace(/^data:\s*/, "").trim();
  if (!line) return null;
  try {
    const parsed = JSON.parse(line) as {
      type?: unknown;
      data?: unknown;
      meta?: { at?: string };
    };
    if (typeof parsed.type !== "string") return null;
    return {
      type: parsed.type,
      data:
        parsed.data && typeof parsed.data === "object"
          ? (parsed.data as Record<string, unknown>)
          : {},
      meta: parsed.meta,
    };
  } catch {
    return null;
  }
}

interface TurnProjection {
  turnId: string;
  index: number;
  userText: string | null;
  /** Every settled assistant message of the turn (they interleave with tool steps). */
  messages: string[];
  /** Partial text of a message that never completed (turn cut off mid-stream). */
  partial: string | null;
  inputRequests: ChatInputRequest[];
  modelId: string | null;
  steps: ChatStep[];
  error: string | null;
  stepStarts: Map<number, number>;
  actionsBySeq: Map<number, TurnAction[]>;
  actionByCallId: Map<string, TurnAction>;
}

interface TurnAction {
  toolName: string;
  summary?: string;
  exitCode?: number;
  isError?: boolean;
}

function projectEventsToEntries(
  events: EveStreamEvent[],
  session: PlaygroundSession,
): ChatEntry[] {
  const turns = new Map<string, TurnProjection>();
  const ordered: TurnProjection[] = [];
  let modelId: string | null = null;

  const turnFor = (turnId: string | null): TurnProjection | null => {
    if (!turnId) return null;
    let turn = turns.get(turnId);
    if (!turn) {
      turn = {
        turnId,
        index: ordered.length,
        userText: null,
        messages: [],
        partial: null,
        inputRequests: [],
        modelId,
        steps: [],
        error: null,
        stepStarts: new Map(),
        actionsBySeq: new Map(),
        actionByCallId: new Map(),
      };
      turns.set(turnId, turn);
      ordered.push(turn);
    }
    return turn;
  };

  for (const event of events) {
    const data = event.data;
    const turnId = typeof data.turnId === "string" ? data.turnId : null;
    const turn = turnFor(turnId);
    const at = event.meta?.at ? Date.parse(event.meta.at) : Date.now();
    const stepIndex = typeof data.stepIndex === "number" ? data.stepIndex : 0;
    const sequence = typeof data.sequence === "number" ? data.sequence : stepIndex;

    switch (event.type) {
      case "session.started": {
        const runtime = data.runtime as Record<string, unknown> | undefined;
        if (runtime && typeof runtime.modelId === "string") {
          modelId = runtime.modelId;
        }
        break;
      }
      case "turn.started":
        if (turn && !turn.modelId) turn.modelId = modelId;
        break;
      case "message.received":
        if (turn) turn.userText = textOf(data.message) ?? turn.userText;
        break;
      case "step.started":
        turn?.stepStarts.set(sequence, at);
        break;
      case "actions.requested": {
        if (!turn) break;
        const actions = Array.isArray(data.actions) ? data.actions : [];
        const seqActions = turn.actionsBySeq.get(sequence) ?? [];
        for (const rawAction of actions) {
          if (typeof rawAction !== "object" || rawAction === null) continue;
          const action = rawAction as Record<string, unknown>;
          const toolName =
            typeof action.toolName === "string" ? action.toolName : "tool";
          const summary = summarizeActionInput(action.input);
          const record: TurnAction = { toolName, summary };
          seqActions.push(record);
          if (typeof action.callId === "string") {
            turn.actionByCallId.set(action.callId, record);
          }
        }
        turn.actionsBySeq.set(sequence, seqActions);
        break;
      }
      case "action.result": {
        if (!turn) break;
        const result = data.result as Record<string, unknown> | undefined;
        const callId =
          result && typeof result.callId === "string" ? result.callId : null;
        const record = callId ? turn.actionByCallId.get(callId) : undefined;
        if (!record) break;
        const output = result?.output;
        if (
          output &&
          typeof output === "object" &&
          typeof (output as Record<string, unknown>).exitCode === "number"
        ) {
          record.exitCode = (output as Record<string, unknown>).exitCode as number;
        }
        record.isError =
          data.status === "failed" || (record.exitCode != null && record.exitCode !== 0);
        break;
      }
      case "message.appended":
        // Cumulative for the CURRENT message only — kept as a fallback in case the
        // message never completes (turn cut off mid-stream).
        if (turn && typeof data.messageSoFar === "string") {
          turn.partial = data.messageSoFar;
        }
        break;
      case "message.completed": {
        if (!turn) break;
        const message = textOf(data.message) ?? textOf(data);
        if (message) turn.messages.push(message);
        turn.partial = null;
        break;
      }
      case "input.requested":
        // The agent asked the user something (ask_question / tool approval).
        if (turn) turn.inputRequests.push(...inputRequestsOf(data));
        break;
      case "step.completed":
      case "step.failed": {
        if (!turn) break;
        const failure =
          event.type === "step.failed" ? failureOf(data, "The agent step failed.") : null;
        if (failure) turn.error = failure.text;
        const usage = data.usage as Record<string, unknown> | undefined;
        const started = turn.stepStarts.get(sequence);
        const actions = turn.actionsBySeq.get(sequence);
        const primary = actions?.[0];
        turn.steps.push({
          type: event.type,
          name: stringField(data, "name"),
          durationMs: started != null ? Math.max(0, at - started) : null,
          tokensIn:
            usage && typeof usage.inputTokens === "number" ? usage.inputTokens : null,
          tokensOut:
            usage && typeof usage.outputTokens === "number" ? usage.outputTokens : null,
          isError: event.type === "step.failed",
          code: failure?.code ?? null,
          message: failure?.message ?? null,
          details: failure?.details ?? null,
          toolName: primary?.toolName ?? null,
          summary: primary?.summary ?? null,
        });
        break;
      }
      case "turn.failed":
      case "session.failed":
        if (turn || event.type === "session.failed") {
          const failure = failureOf(data, "The turn failed.");
          const targetTurn = turn ?? ordered.at(-1);
          if (targetTurn) targetTurn.error = failure.text;
        }
        break;
    }
  }

  const entries: ChatEntry[] = [];
  for (const turn of ordered) {
    if (turn.userText) {
      entries.push({
        id: `${turn.turnId}:user`,
        role: "user",
        text: turn.userText,
      });
    }
    const reply =
      turn.messages.length > 0
        ? [...turn.messages, ...(turn.partial ? [turn.partial] : [])].join("\n\n")
        : turn.partial;
    if (
      reply !== null ||
      turn.inputRequests.length > 0 ||
      turn.error !== null ||
      turn.steps.length > 0
    ) {
      const normalized = normalizeReply(reply);
      entries.push({
        id: `${turn.turnId}:assistant`,
        role: "assistant",
        text: normalized.reply ?? "",
        structured: normalized.replyIsStructured,
        version: session.lastVersion ?? undefined,
        modelId: turn.modelId,
        steps: turn.steps,
        inputRequests:
          turn.inputRequests.length > 0 ? turn.inputRequests : undefined,
        error: turn.error,
      });
    }
  }
  return entries;
}

function textOf(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const text = (part as Record<string, unknown>).text;
          return typeof text === "string" ? text : null;
        }
        return null;
      })
      .filter((part): part is string => !!part);
    return parts.length > 0 ? parts.join(" ") : null;
  }
  if (typeof value !== "object" || value === null) return null;
  const object = value as Record<string, unknown>;
  for (const key of ["text", "content", "message", "output", "result", "reply"]) {
    const nested = object[key];
    if (typeof nested === "string" && nested.trim()) return nested;
    if (typeof nested === "object" && nested !== null) {
      const text = textOf(nested);
      if (text) return text;
    }
  }
  return null;
}

function stringField(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function compactText(value: string, max = 2_000): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function detailsOf(value: unknown): string | null {
  if (typeof value === "string") {
    return value.trim() ? compactText(value.trim()) : null;
  }
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return compactText(JSON.stringify(value, null, 2));
  } catch {
    return null;
  }
}

function failureOf(
  data: Record<string, unknown>,
  fallback: string,
): { message: string; code?: string; details?: string; text: string } {
  const message = stringField(data, "message") ?? textOf(data) ?? fallback;
  const code = stringField(data, "code") ?? undefined;
  const details = detailsOf(data.details) ?? undefined;
  return {
    message,
    code,
    details,
    text: [
      message,
      code ? `Code: ${code}` : null,
      details ? `Details: ${details}` : null,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

function summarizeActionInput(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const object = input as Record<string, unknown>;
  const preferred =
    object.command ?? object.skill ?? object.path ?? object.file_path ?? firstStringValue(object);
  if (typeof preferred !== "string") return undefined;
  const trimmed = preferred.trim().replace(/\s+/g, " ");
  if (!trimmed) return undefined;
  return trimmed.length > 160 ? `${trimmed.slice(0, 159)}…` : trimmed;
}

function firstStringValue(obj: Record<string, unknown>): string | undefined {
  for (const value of Object.values(obj)) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function normalizeReply(reply: string | null): {
  reply: string | null;
  replyIsStructured: boolean;
} {
  if (!reply) return { reply, replyIsStructured: false };
  const trimmed = reply.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return {
        reply: JSON.stringify(JSON.parse(trimmed), null, 2),
        replyIsStructured: true,
      };
    } catch {
      // Plain prose that happens to start with a brace.
    }
  }
  return { reply, replyIsStructured: false };
}
