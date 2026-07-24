/**
 * Front of House needs-you decisions — the pure logic behind the two event-drain chokepoints
 * (D4/D13). Keeping this out of the drain means the park/settle rules are unit-testable without
 * mocks, and the chokepoint edits in `turn-stream.server.ts` / `sessions.server.ts` stay thin.
 *
 * Two facts shape the rules (verified against eve behavior in `talk.server.ts`):
 * - A turn that ends with pending `input.requested`s IS parked, even when assistant text
 *   preceded the ask ("One thing before I continue — …?" is the common shape), so a
 *   reply does not negate a park.
 * - Answers are a follow-up user message on the session (a `message.received` on a later
 *   turn), never an in-turn resolution — so within one turn, requests only accumulate.
 */
import type { ChatInputRequest } from "~/chat/types";

export type FohTurnOutcome = "parked" | "completed" | "failed";

/** Which chokepoint mutations apply when a live-drained turn settles. */
export interface FohTurnSettle {
  outcome: FohTurnOutcome;
  /** Clear `pendingInputAt` on the session row. */
  clearPending: boolean;
  /** Resolve the session's pending question/approval inbox items. */
  resolveAsks: boolean;
  /** File the D13 `finished` inbox item. */
  recordFinished: boolean;
}

/**
 * Decide the terminal mutations for a turn the live drain just finished (chokepoint #1).
 * The park state itself was already written when the `input` event arrived; this only decides
 * whether the turn's end supersedes it.
 */
export function settleFohTurn(result: {
  ok: boolean;
  inputRequests: readonly ChatInputRequest[];
}): FohTurnSettle {
  if (!result.ok) {
    // The session shows done-with-error; a stale park must not keep asking for a human.
    return {
      outcome: "failed",
      clearPending: true,
      resolveAsks: true,
      recordFinished: false,
    };
  }
  if (result.inputRequests.length > 0) {
    return {
      outcome: "parked",
      clearPending: false,
      resolveAsks: false,
      recordFinished: false,
    };
  }
  return {
    outcome: "completed",
    clearPending: true,
    resolveAsks: true,
    recordFinished: true,
  };
}

/** The event shape the reconcile tail carries (sessions.server.ts's EveStreamEvent). */
export interface TailEventLike {
  type: string;
  data: Record<string, unknown>;
}

export type ReconcileNeedsYou =
  /** The newest turn parked on unanswered requests — set the flag, upsert their items. */
  | { action: "park"; requestData: Record<string, unknown>[] }
  /** The tail proves the park is over (answered/completed/failed) — clear + resolve. */
  | { action: "settle" }
  /** Indeterminate (mid-turn activity, or just a `session.waiting` marker settling an
   *  already-recorded park) — leave the stored park state alone. */
  | { action: "none" };

/**
 * Loader-side recovery decision (chokepoint #2): what a reconciled eve tail says about the
 * needs-you state. Returns the raw `input.requested` payloads of asks that survive the tail
 * (newest turn only — a later user message answers/supersedes earlier asks); the caller maps
 * them through `inputRequestsOf`.
 *
 * A bare `session.waiting` tail is deliberately `none`, not `settle`: when the drain died
 * after persisting the park but before the terminal marker, the recovered tail is just the
 * waiting event — clearing there would erase a real park.
 */
export function reconcileNeedsYouFromTail(
  events: readonly TailEventLike[],
): ReconcileNeedsYou {
  let requestData: Record<string, unknown>[] = [];
  let requestTurnId: string | null = null;
  let failed = false;
  let completed = false;
  for (const event of events) {
    const turnId =
      typeof event.data.turnId === "string" ? event.data.turnId : null;
    switch (event.type) {
      case "input.requested":
        // Asks on a newer turn supersede an older turn's (eve no longer holds the old ones).
        if (requestTurnId !== null && turnId !== requestTurnId) requestData = [];
        requestTurnId = turnId;
        requestData.push(event.data);
        break;
      case "message.received":
        // A new user message — the answer to any outstanding ask, or a superseding turn.
        requestData = [];
        requestTurnId = null;
        failed = false;
        completed = false;
        break;
      case "turn.completed":
      case "message.completed":
        // Completion counts only while no ask is outstanding: eve emits the turn-closing
        // markers after `input.requested` too, and those do not mean "answered".
        if (requestTurnId === null) completed = true;
        break;
      case "turn.failed":
      case "session.failed":
        requestData = [];
        requestTurnId = null;
        failed = true;
        break;
    }
  }
  if (requestData.length > 0) return { action: "park", requestData };
  if (failed || completed) return { action: "settle" };
  return { action: "none" };
}

export type FohSessionRepair =
  /** The park write failed at drain time — re-park these requests into the inbox. */
  | { action: "park"; requests: ChatInputRequest[] }
  /** The settle write failed — the needs-you badge lies; clear the flag and resolve items. */
  | { action: "settle" }
  /** Consistent (or indeterminate: running/stopped) — leave everything alone. */
  | { action: "none" };

/**
 * Loader-side repair decision (issue #221 finding 4) — the durable retry for a park/settle
 * write the drain swallowed. Judged from the durable transcript cache (the newest entry)
 * against the session row's flag, per the needs-you doctrine: a turn ending with pending
 * `input.requested`s IS parked.
 *
 * - `waiting` + newest entry is an assistant ask (pending inputRequests, no error) but the
 *   flag is unset → park (the drain's park write failed).
 * - `waiting`/`failed`/`completed` + NO pending ask on the newest entry but the flag is set
 *   → settle (the drain's clear write failed; the badge lies).
 * - Anything else (`running`, `stopped`, or a consistent row) → none.
 */
export function repairFohSessionState(input: {
  status: string;
  pendingInputAt: Date | null;
  lastEntry: {
    role: string;
    inputRequests?: ChatInputRequest[];
    error?: string | null;
  } | null;
}): FohSessionRepair {
  const pendingAsks =
    input.lastEntry?.role === "assistant" && !input.lastEntry.error
      ? (input.lastEntry.inputRequests ?? [])
      : [];
  if (
    input.status === "waiting" &&
    pendingAsks.length > 0 &&
    input.pendingInputAt === null
  ) {
    return { action: "park", requests: pendingAsks };
  }
  if (
    (input.status === "waiting" ||
      input.status === "failed" ||
      input.status === "completed") &&
    pendingAsks.length === 0 &&
    input.pendingInputAt !== null
  ) {
    return { action: "settle" };
  }
  return { action: "none" };
}
