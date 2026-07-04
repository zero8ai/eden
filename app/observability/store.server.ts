/**
 * Runs store + ingest (Observe pillar, M3 — PRD §7.6, ARCH §3.7).
 *
 * Normalizes telemetry (eve OTel spans + Workflow event log) into Session → Run → Step. BYO
 * instances POST here with a per-project ingest token; managed instances are co-located but
 * use the same path. The system prompt is reconstructed from the Run's Release commit (link,
 * not snapshot); user input, tool I/O, tokens, and timing are runtime data and are stored.
 */
import crypto from "node:crypto";
import { and, desc, eq } from "drizzle-orm";

import { db } from "~/db/client.server";
import { agents, ingestTokens, releases, runSteps, runs, sessions } from "~/db/schema";

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** Mint a project ingest token. Returns the plaintext ONCE; only the hash is stored. */
export async function createIngestToken(projectId: string, name: string) {
  const token = `edn_${crypto.randomBytes(24).toString("base64url")}`;
  await db
    .insert(ingestTokens)
    .values({ projectId, name, tokenHash: hashToken(token) });
  return token;
}

export function listIngestTokens(projectId: string) {
  return db
    .select({
      id: ingestTokens.id,
      name: ingestTokens.name,
      createdAt: ingestTokens.createdAt,
      lastUsedAt: ingestTokens.lastUsedAt,
    })
    .from(ingestTokens)
    .where(eq(ingestTokens.projectId, projectId))
    .orderBy(desc(ingestTokens.createdAt));
}

/** Resolve a Bearer ingest token to its project id, or null. Bumps lastUsedAt on hit. */
export async function resolveIngestToken(token: string): Promise<string | null> {
  const [row] = await db
    .select()
    .from(ingestTokens)
    .where(eq(ingestTokens.tokenHash, hashToken(token)))
    .limit(1);
  if (!row) return null;
  await db
    .update(ingestTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(ingestTokens.id, row.id));
  return row.projectId;
}

export interface IngestStep {
  seq: number;
  type: "model_call" | "tool_call" | "reasoning" | "message";
  model?: string;
  toolName?: string;
  tokensInput?: number;
  tokensOutput?: number;
  durationMs?: number;
  isError?: boolean;
  approvalGated?: boolean;
  data?: Record<string, unknown>;
  startedAt?: string;
}

export interface IngestPayload {
  externalRunId: string;
  deploymentId?: string;
  releaseId?: string;
  channel?: string;
  status?: "running" | "completed" | "failed";
  tokensInput?: number;
  tokensOutput?: number;
  wallClockMs?: number;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  metadata?: Record<string, unknown>;
  session?: { externalSessionId?: string; trigger?: string; channel?: string };
  steps?: IngestStep[];
}

/**
 * The roster member a run belongs to: the release's agent when the payload carries one,
 * else the sole member (single-agent repos). Multi-member runs without a release stay
 * unattributed (null) rather than guessing.
 */
async function resolveRunAgent(
  projectId: string,
  releaseId: string | undefined,
): Promise<string | null> {
  if (releaseId) {
    const [rel] = await db
      .select({ agentId: releases.agentId })
      .from(releases)
      .where(eq(releases.id, releaseId))
      .limit(1);
    if (rel) return rel.agentId;
  }
  const roster = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.projectId, projectId))
    .limit(2);
  return roster.length === 1 ? roster[0].id : null;
}

/** Ingest one run (+ optional session + steps) for a project. Idempotent per externalRunId. */
export async function ingestRun(projectId: string, p: IngestPayload): Promise<void> {
  const agentId = await resolveRunAgent(projectId, p.releaseId);
  let sessionId: string | null = null;
  if (p.session?.externalSessionId) {
    const [s] = await db
      .insert(sessions)
      .values({
        projectId,
        agentId,
        externalSessionId: p.session.externalSessionId,
        trigger: p.session.trigger ?? null,
        channel: p.session.channel ?? null,
      })
      .onConflictDoUpdate({
        target: [sessions.projectId, sessions.externalSessionId],
        set: { trigger: p.session.trigger ?? null },
      })
      .returning();
    sessionId = s.id;
  }

  const [run] = await db
    .insert(runs)
    .values({
      projectId,
      agentId,
      deploymentId: p.deploymentId ?? null,
      releaseId: p.releaseId ?? null,
      sessionId,
      externalRunId: p.externalRunId,
      channel: p.channel ?? null,
      status: p.status ?? "running",
      tokensInput: p.tokensInput ?? null,
      tokensOutput: p.tokensOutput ?? null,
      wallClockMs: p.wallClockMs ?? null,
      error: p.error ?? null,
      metadata: p.metadata ?? {},
      ...(p.startedAt ? { startedAt: new Date(p.startedAt) } : {}),
      finishedAt: p.finishedAt ? new Date(p.finishedAt) : null,
    })
    .onConflictDoUpdate({
      target: [runs.projectId, runs.externalRunId],
      set: {
        sessionId,
        agentId,
        deploymentId: p.deploymentId ?? null,
        releaseId: p.releaseId ?? null,
        status: p.status ?? "running",
        tokensInput: p.tokensInput ?? null,
        tokensOutput: p.tokensOutput ?? null,
        wallClockMs: p.wallClockMs ?? null,
        error: p.error ?? null,
        finishedAt: p.finishedAt ? new Date(p.finishedAt) : null,
      },
    })
    .returning();

  if (p.steps && p.steps.length > 0) {
    // Replace steps for idempotency (a later event carries the full step list).
    await db.delete(runSteps).where(eq(runSteps.runId, run.id));
    await db.insert(runSteps).values(
      p.steps.map((st) => ({
        runId: run.id,
        seq: st.seq,
        type: st.type,
        model: st.model ?? null,
        toolName: st.toolName ?? null,
        tokensInput: st.tokensInput ?? null,
        tokensOutput: st.tokensOutput ?? null,
        durationMs: st.durationMs ?? null,
        isError: st.isError ?? false,
        approvalGated: st.approvalGated ?? false,
        data: st.data ?? {},
        startedAt: st.startedAt ? new Date(st.startedAt) : null,
      })),
    );
  }
}

/** Run list for a project, optionally filtered by Release and/or roster member (§7.9). */
export function listRuns(
  projectId: string,
  filter: { releaseId?: string; agentId?: string } = {},
) {
  const conditions = [eq(runs.projectId, projectId)];
  if (filter.releaseId) conditions.push(eq(runs.releaseId, filter.releaseId));
  if (filter.agentId) conditions.push(eq(runs.agentId, filter.agentId));
  const where = and(...conditions);
  return db
    .select({
      id: runs.id,
      externalRunId: runs.externalRunId,
      channel: runs.channel,
      status: runs.status,
      tokensInput: runs.tokensInput,
      tokensOutput: runs.tokensOutput,
      wallClockMs: runs.wallClockMs,
      error: runs.error,
      startedAt: runs.startedAt,
      version: releases.version,
    })
    .from(runs)
    .leftJoin(releases, eq(runs.releaseId, releases.id))
    .where(where)
    .orderBy(desc(runs.startedAt))
    .limit(200);
}

/** One run with its ordered steps (the transcript), scoped to the project. */
export async function getRunWithSteps(projectId: string, runId: string) {
  const [run] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.projectId, projectId), eq(runs.id, runId)))
    .limit(1);
  if (!run) return null;
  const steps = await db
    .select()
    .from(runSteps)
    .where(eq(runSteps.runId, run.id))
    .orderBy(runSteps.seq);
  const release = run.releaseId
    ? (await db.select().from(releases).where(eq(releases.id, run.releaseId)).limit(1))[0]
    : undefined;
  return { run, steps, release };
}
