/**
 * Capability-call audit log (issue #166). One row per capability request that passed delegation
 * auth — allowed, refused, or errored — written by the framework (execute.server.ts) for EVERY
 * such call. Direct-Drizzle append, mirroring grants.server.ts. `inputSummary` is the
 * operation-defined redacted digest; the raw payload never lands here.
 *
 * Two write shapes:
 *  - `recordCapabilityCall`: single append for outcomes known up front (refusals, pre-execute
 *    errors) — nothing reached the vendor, so a failed write costs only the log line.
 *  - `beginCapabilityCall` / `finalizeCapabilityCall`: WRITE-AHEAD pair around the vendor
 *    execution. The "pending" row is inserted BEFORE `execute()` runs and the caller treats an
 *    insert failure as a refusal — so a vendor mutation can never exist without a queryable row.
 *    The finalize settles it to "ok"/"error"; if THAT write fails, the pending row still records
 *    that the call ran.
 */
import { eq } from "drizzle-orm";

import { db } from "~/db/client.server";
import { capabilityCalls } from "~/db/schema";

export type CapabilityCallOutcome = "ok" | "refused" | "error" | "pending";

export interface CapabilityCallRecord {
  agentId: string;
  deploymentId: string;
  provider: string;
  operation: string;
  /** The operation's group; null when the request named an unknown operation. */
  groupId: string | null;
  outcome: CapabilityCallOutcome;
  /** Refusal/error text returned to the caller; null for "ok". */
  error: string | null;
  /** Operation-defined redacted input digest — never the raw payload. */
  inputSummary: Record<string, unknown>;
}

/** Append one audit row whose outcome is already known (refusals, pre-execute errors). */
export async function recordCapabilityCall(
  record: CapabilityCallRecord,
): Promise<void> {
  await db.insert(capabilityCalls).values({
    agentId: record.agentId,
    deploymentId: record.deploymentId,
    provider: record.provider,
    operation: record.operation,
    groupId: record.groupId,
    outcome: record.outcome,
    error: record.error,
    inputSummary: record.inputSummary,
  });
}

/**
 * Write-ahead row for an execution about to run: outcome "pending", inserted BEFORE the vendor
 * operation. Returns the row id for `finalizeCapabilityCall`. Throws on failure — the caller must
 * refuse the call rather than execute unrecorded.
 */
export async function beginCapabilityCall(
  record: Omit<CapabilityCallRecord, "outcome" | "error">,
): Promise<string> {
  const [row] = await db
    .insert(capabilityCalls)
    .values({
      agentId: record.agentId,
      deploymentId: record.deploymentId,
      provider: record.provider,
      operation: record.operation,
      groupId: record.groupId,
      outcome: "pending",
      error: null,
      inputSummary: record.inputSummary,
    })
    .returning({ id: capabilityCalls.id });
  return row.id;
}

/** Settle a write-ahead row with the execution's outcome. */
export async function finalizeCapabilityCall(
  id: string,
  outcome: "ok" | "error",
  error: string | null,
): Promise<void> {
  await db
    .update(capabilityCalls)
    .set({ outcome, error })
    .where(eq(capabilityCalls.id, id));
}
