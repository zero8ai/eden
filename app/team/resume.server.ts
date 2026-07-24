/**
 * Delegation wake-on-answer (Front of House §5): when a turn on a delegation-linked FOH
 * session — the agent-opened row the relay parked — reaches its terminal state, settle the
 * `waiting` delegation row. Called from the shared drain's finally block, so it runs with no
 * client connected. The calling model already received the structured `waiting_on_human`
 * result, so nothing is pushed back to the asker — the delegation just finalizes normally
 * (PRD). A resumed turn that parks AGAIN keeps `waiting` (the drain chokepoint already filed
 * the fresh inbox item).
 */
import type { DataStore } from "~/data/ports";
import type { FohTurnOutcome } from "~/foh/needs-you";
import { getRuntime } from "~/seams/index.server";

export async function finalizeDelegationOnResume(
  input: {
    delegationId: string;
    outcome: FohTurnOutcome;
    error?: string | null;
  },
  store: DataStore = getRuntime().data,
): Promise<void> {
  const delegation = await store.delegations.findById(input.delegationId);
  // Only a parked (waiting) delegation is ours to settle: completed/failed rows were
  // finalized by the relay itself, and `running` means the relay is still blocked in sendTurn
  // (its own settle is coming — racing it would clobber the reply-path finalize).
  if (!delegation || delegation.status !== "waiting") return;
  if (input.outcome === "completed") {
    await store.delegations.finalize(input.delegationId, {
      status: "completed",
    });
  } else if (input.outcome === "failed") {
    await store.delegations.finalize(input.delegationId, {
      status: "failed",
      error: input.error ?? "The resumed turn failed.",
    });
  }
}
