/**
 * Optional progressive rollout over the traffic splitter (M5 — PRD §11/§7.7).
 *
 * A policy layered on the weighted split (D9) + per-version telemetry (D8): ramp a canary
 * Release's traffic while its error rate stays healthy, and auto-roll-back if it degrades. This
 * is deliberately not on by default (D10 keeps "A/B" human-judged); it's a helper a scheduler
 * or an operator can call to step a rollout. The health signal is real — computed from the runs
 * store — so the decision is grounded, not simulated.
 */
import { and, eq, sql } from "drizzle-orm";

import { db } from "~/db/client.server";
import { deployments, runs } from "~/db/schema";
import { setTrafficSplit } from "./controller.server";

export interface ReleaseHealth {
  total: number;
  failed: number;
  errorRate: number;
}

/** Error rate for a Release from the runs store (all recorded runs for that release). */
export async function releaseHealth(
  projectId: string,
  releaseId: string,
): Promise<ReleaseHealth> {
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      failed: sql<number>`sum(case when ${runs.status} = 'failed' then 1 else 0 end)::int`,
    })
    .from(runs)
    .where(and(eq(runs.projectId, projectId), eq(runs.releaseId, releaseId)));
  const total = row?.total ?? 0;
  const failed = row?.failed ?? 0;
  return { total, failed, errorRate: total > 0 ? failed / total : 0 };
}

export interface RolloutStepInput {
  projectId: string;
  environmentId: string;
  canaryDeploymentId: string;
  baselineDeploymentId: string;
  /** Weight (out of 100) to add to the canary each healthy step. */
  stepWeight?: number;
  /** Minimum canary runs before acting on the error rate. */
  minRuns?: number;
  /** Error-rate ceiling; above it, roll back. */
  errorThreshold?: number;
}

export type RolloutAction = "hold" | "promote" | "complete" | "rollback";

export interface RolloutStepResult {
  action: RolloutAction;
  canaryWeight: number;
  health: ReleaseHealth;
  detail: string;
}

/**
 * Advance (or roll back) a canary one step based on its live error rate. Promotes by shifting
 * `stepWeight` from baseline to canary while healthy; rolls the canary to 0 if it exceeds the
 * error threshold; holds until it has enough runs to judge.
 */
export async function progressiveRolloutStep(
  input: RolloutStepInput,
): Promise<RolloutStepResult> {
  const stepWeight = input.stepWeight ?? 10;
  const minRuns = input.minRuns ?? 5;
  const errorThreshold = input.errorThreshold ?? 0.1;

  const [canary] = await db
    .select()
    .from(deployments)
    .where(eq(deployments.id, input.canaryDeploymentId))
    .limit(1);
  if (!canary) throw new Error("Canary deployment not found.");

  const health = await releaseHealth(input.projectId, canary.releaseId);

  const apply = async (canaryWeight: number) => {
    await setTrafficSplit(input.environmentId, [
      { deploymentId: input.canaryDeploymentId, weight: canaryWeight },
      { deploymentId: input.baselineDeploymentId, weight: 100 - canaryWeight },
    ]);
  };

  if (health.total < minRuns) {
    return {
      action: "hold",
      canaryWeight: canary.trafficWeight,
      health,
      detail: `Holding at ${canary.trafficWeight}% — only ${health.total}/${minRuns} runs.`,
    };
  }

  if (health.errorRate > errorThreshold) {
    await apply(0);
    return {
      action: "rollback",
      canaryWeight: 0,
      health,
      detail: `Rolled back — error rate ${(health.errorRate * 100).toFixed(1)}% > ${(errorThreshold * 100).toFixed(0)}%.`,
    };
  }

  const next = Math.min(100, canary.trafficWeight + stepWeight);
  await apply(next);
  return {
    action: next >= 100 ? "complete" : "promote",
    canaryWeight: next,
    health,
    detail:
      next >= 100
        ? "Canary at 100% — rollout complete."
        : `Promoted canary to ${next}% (error rate ${(health.errorRate * 100).toFixed(1)}%).`,
  };
}
