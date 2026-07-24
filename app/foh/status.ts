/**
 * Front of House session status — the pure mapping from a session row's stored fields to the
 * three-state (plus error) presentation FOH lists render (D4).
 *
 * `status = 'waiting'` does NOT mean parked on a question: the drain writes `waiting` for every
 * successful turn end. The parked ("needs you") state is its own stored signal,
 * `pendingInputAt`, written/cleared only at the needs-you chokepoints (drain, reconcile, relay)
 * and the send path.
 */

export type FohSessionStatus = "working" | "needs_you" | "done" | "error";

/** The stored-field slice the mapping needs; PlaygroundSession satisfies it. */
export interface FohStatusInput {
  /** new | running | waiting | completed | failed | stopped */
  status: string;
  pendingInputAt: Date | null;
}

export function fohSessionStatus(session: FohStatusInput): FohSessionStatus {
  // A running turn wins: the send path clears pendingInputAt, but even if a stale flag
  // survives a race, "working" is the truthful live state.
  if (session.status === "running") return "working";
  if (session.pendingInputAt) return "needs_you";
  if (session.status === "failed") return "error";
  // waiting | completed | stopped | new (and any unknown value) settle as done.
  return "done";
}

/**
 * FOH middle-pane ordering: sessions that need a human first (oldest ask first, so the
 * longest-waiting question surfaces on top), then everything else by recency.
 */
export function sortSessionsForList<
  T extends FohStatusInput & { updatedAt: Date },
>(sessions: T[]): T[] {
  return [...sessions].sort((a, b) => {
    const aNeeds = fohSessionStatus(a) === "needs_you";
    const bNeeds = fohSessionStatus(b) === "needs_you";
    if (aNeeds !== bNeeds) return aNeeds ? -1 : 1;
    if (aNeeds && bNeeds) {
      return (
        (a.pendingInputAt?.getTime() ?? 0) - (b.pendingInputAt?.getTime() ?? 0)
      );
    }
    return b.updatedAt.getTime() - a.updatedAt.getTime();
  });
}
