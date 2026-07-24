/**
 * Front of House activity feed — the server half (§5). Reads the four existing tables
 * (FOH sessions, delegations, runs, deployments) with parallel per-source queries, each
 * already cursor-cut (`at < before`), newest-first and limited, then hands the rows to the
 * pure projection in activity.ts. No new write path, no materialized table (PRD: only if the
 * projection provably can't keep up).
 */
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  lt,
  type AnyColumn,
  type SQL,
} from "drizzle-orm";

import { user } from "~/db/auth-schema";
import { db } from "~/db/client.server";
import {
  agents,
  delegations,
  deployments,
  environments,
  playgroundSessions,
  releases,
  runs,
  runSteps,
} from "~/db/schema";
import {
  projectActivity,
  summarizeExchangeSteps,
  type ActivityPage,
  type ExchangeStep,
} from "~/foh/activity";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** `col < before`, or no condition on the first page (and() drops undefined). */
const cutoff = (col: AnyColumn, before?: Date): SQL | undefined =>
  before ? lt(col, before) : undefined;

export async function listTeamActivity(
  projectId: string,
  opts: { before?: Date; limit?: number } = {},
): Promise<ActivityPage> {
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const { before } = opts;

  const [sessionRows, delegationRows, runRows, deploymentRows, agentRows] =
    await Promise.all([
      db
        .select({
          id: playgroundSessions.id,
          createdAt: playgroundSessions.createdAt,
          agentId: playgroundSessions.agentId,
          createdBy: playgroundSessions.createdBy,
          openedByAgentId: playgroundSessions.openedByAgentId,
          title: playgroundSessions.title,
        })
        .from(playgroundSessions)
        .where(
          and(
            eq(playgroundSessions.projectId, projectId),
            eq(playgroundSessions.surface, "foh"),
            cutoff(playgroundSessions.createdAt, before),
          ),
        )
        .orderBy(desc(playgroundSessions.createdAt))
        .limit(limit),
      db
        .select({
          id: delegations.id,
          startedAt: delegations.startedAt,
          finishedAt: delegations.finishedAt,
          status: delegations.status,
          error: delegations.error,
          fromAgentId: delegations.fromAgentId,
          toAgentId: delegations.toAgentId,
          runId: delegations.runId,
        })
        .from(delegations)
        .where(
          and(
            eq(delegations.projectId, projectId),
            cutoff(delegations.startedAt, before),
          ),
        )
        .orderBy(desc(delegations.startedAt))
        .limit(limit),
      db
        .select({
          id: runs.id,
          startedAt: runs.startedAt,
          status: runs.status,
          channel: runs.channel,
          agentId: runs.agentId,
          error: runs.error,
          metadata: runs.metadata,
        })
        .from(runs)
        .where(and(eq(runs.projectId, projectId), cutoff(runs.startedAt, before)))
        .orderBy(desc(runs.startedAt))
        .limit(limit),
      db
        .select({
          id: deployments.id,
          createdAt: deployments.createdAt,
          status: deployments.status,
          agentId: environments.agentId,
          version: releases.version,
        })
        .from(deployments)
        .innerJoin(environments, eq(deployments.environmentId, environments.id))
        .leftJoin(releases, eq(deployments.releaseId, releases.id))
        .where(
          and(
            eq(environments.projectId, projectId),
            cutoff(deployments.createdAt, before),
          ),
        )
        .orderBy(desc(deployments.createdAt))
        .limit(limit),
      db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(eq(agents.projectId, projectId)),
    ]);

  // Delegation ask text lives on the linked run's metadata (runId is best-effort — the
  // relay records it try/caught, so misses just render without a quote).
  const linkedRunIds = [
    ...new Set(
      delegationRows.map((d) => d.runId).filter((id): id is string => id != null),
    ),
  ];
  const askRows = linkedRunIds.length
    ? await db
        .select({ id: runs.id, metadata: runs.metadata })
        .from(runs)
        .where(and(eq(runs.projectId, projectId), inArray(runs.id, linkedRunIds)))
    : [];
  const askByRunId = new Map(
    askRows.map((r) => [
      r.id,
      typeof r.metadata?.input === "string" ? r.metadata.input : null,
    ]),
  );

  const openerIds = [
    ...new Set(
      sessionRows.map((s) => s.createdBy).filter((id): id is string => id != null),
    ),
  ];
  const userRows = openerIds.length
    ? await db
        .select({ id: user.id, name: user.name })
        .from(user)
        .where(inArray(user.id, openerIds))
    : [];

  return projectActivity(
    {
      sessions: sessionRows,
      delegations: delegationRows,
      runs: runRows,
      deployments: deploymentRows,
    },
    {
      limit,
      agentNames: new Map(agentRows.map((a) => [a.id, a.name])),
      userNames: new Map(userRows.map((u) => [u.id, u.name])),
      askByRunId,
    },
  );
}

export interface DelegationExchange {
  delegationId: string;
  status: string;
  error: string | null;
  fromAgentName: string | null;
  toAgentName: string | null;
  startedAt: string;
  /** Only for settled rows (a waiting row's finishedAt is park-time bookkeeping, WP4). */
  finishedAt: string | null;
  /** The ask, from the linked run's metadata; null when the run never landed. */
  ask: string | null;
  /** The exchange transcript from the linked run's steps; empty when runId is null. */
  steps: ExchangeStep[];
}

/** The full sam → ivy exchange behind one delegation entry (§6 legibility). */
export async function getDelegationExchange(
  projectId: string,
  delegationId: string,
): Promise<DelegationExchange | null> {
  const [row] = await db
    .select()
    .from(delegations)
    .where(and(eq(delegations.id, delegationId), eq(delegations.projectId, projectId)))
    .limit(1);
  if (!row) return null;

  const agentIds = [row.fromAgentId, row.toAgentId].filter(
    (id): id is string => id != null,
  );
  const agentRows = agentIds.length
    ? await db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(inArray(agents.id, agentIds))
    : [];
  const names = new Map(agentRows.map((a) => [a.id, a.name]));

  let ask: string | null = null;
  let steps: ExchangeStep[] = [];
  if (row.runId) {
    const [run] = await db
      .select({ id: runs.id, metadata: runs.metadata })
      .from(runs)
      .where(and(eq(runs.id, row.runId), eq(runs.projectId, projectId)))
      .limit(1);
    if (run) {
      ask = typeof run.metadata?.input === "string" ? run.metadata.input : null;
      const stepRows = await db
        .select({
          seq: runSteps.seq,
          type: runSteps.type,
          toolName: runSteps.toolName,
          isError: runSteps.isError,
          data: runSteps.data,
        })
        .from(runSteps)
        .where(eq(runSteps.runId, run.id))
        .orderBy(asc(runSteps.seq));
      steps = summarizeExchangeSteps(stepRows);
    }
  }

  const settled = row.status === "completed" || row.status === "failed";
  return {
    delegationId: row.id,
    status: row.status,
    error: row.error,
    fromAgentName: row.fromAgentId != null ? (names.get(row.fromAgentId) ?? null) : null,
    toAgentName: row.toAgentId != null ? (names.get(row.toAgentId) ?? null) : null,
    startedAt: row.startedAt.toISOString(),
    finishedAt: settled && row.finishedAt ? row.finishedAt.toISOString() : null,
    ask,
    steps,
  };
}
