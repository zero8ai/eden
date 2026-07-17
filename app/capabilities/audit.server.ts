/**
 * Capability-call audit log (issue #166). One row per capability request that passed delegation
 * auth — allowed, refused, or errored — written by the framework (execute.server.ts) for EVERY
 * such call. Direct-Drizzle append, mirroring grants.server.ts. `inputSummary` is the
 * operation-defined redacted digest; the raw payload never lands here.
 */
import { db } from "~/db/client.server";
import { capabilityCalls } from "~/db/schema";

export type CapabilityCallOutcome = "ok" | "refused" | "error";

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

/** Append one audit row. Never throws to the caller's benefit — auditing must not mask results. */
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
