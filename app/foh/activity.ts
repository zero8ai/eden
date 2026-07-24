/**
 * Front of House activity feed — the PURE projection half (§5: per-team timeline, no new
 * write path). Four existing tables are merged into one wall-clock-ordered stream:
 * FOH sessions (opened by a human or by a delegating agent), delegations (the sam → ivy
 * conversation entries), runs (agent work on any channel), and deployments.
 *
 * The server half (activity.server.ts) fetches per-source rows (each already cut to
 * `at < before`, newest-first, limited); this module builds/merges/paginates so the logic is
 * unit-testable over plain fixtures. Tolerances are part of the contract: delegation `runId`
 * is best-effort (recording is try/caught), agent FKs are set-null, and delegation env refs
 * have no FK at all — every name lookup may miss.
 */

export interface ActivitySessionRow {
  id: string;
  createdAt: Date;
  agentId: string | null;
  createdBy: string | null;
  openedByAgentId: string | null;
  title: string | null;
}

export interface ActivityDelegationRow {
  id: string;
  startedAt: Date;
  finishedAt: Date | null;
  status: string;
  error: string | null;
  fromAgentId: string | null;
  toAgentId: string | null;
  runId: string | null;
}

export interface ActivityRunRow {
  id: string;
  startedAt: Date;
  status: string;
  channel: string | null;
  agentId: string | null;
  error: string | null;
  metadata: Record<string, unknown> | null;
}

export interface ActivityDeploymentRow {
  id: string;
  createdAt: Date;
  status: string;
  agentId: string | null;
  version: string | null;
}

export interface ActivitySources {
  sessions: ActivitySessionRow[];
  delegations: ActivityDelegationRow[];
  runs: ActivityRunRow[];
  deployments: ActivityDeploymentRow[];
}

interface ActivityEventBase {
  /** `<type>:<rowId>` — unique across sources (React keys, dedupe). */
  id: string;
  /** Wall-clock ISO timestamp the feed orders by. */
  at: string;
}

export type ActivityEvent =
  | (ActivityEventBase & {
      type: "session";
      sessionId: string;
      agentName: string | null;
      /** Human opener (null for agent-opened rows). */
      openedByUserName: string | null;
      /** Delegating agent opener (null for human-opened rows). */
      openedByAgentName: string | null;
      title: string | null;
    })
  | (ActivityEventBase & {
      type: "delegation";
      delegationId: string;
      fromAgentName: string | null;
      toAgentName: string | null;
      status: string;
      /** The ask text, from the linked run's metadata (null when runId never landed). */
      ask: string | null;
      error: string | null;
      /**
       * Rendered only for settled rows: `finalize` stamps finishedAt at park time too, so a
       * `waiting` row's finishedAt is bookkeeping, not an outcome (WP4).
       */
      finishedAt: string | null;
    })
  | (ActivityEventBase & {
      type: "run";
      runId: string;
      agentName: string | null;
      channel: string | null;
      status: string;
      /** Triggering input snippet from run metadata, when recorded. */
      input: string | null;
      error: string | null;
    })
  | (ActivityEventBase & {
      type: "deployment";
      deploymentId: string;
      agentName: string | null;
      status: string;
      version: string | null;
    });

export interface ActivityPage {
  events: ActivityEvent[];
  /** Cursor for the next-older page, or null when this page ran dry. */
  nextBefore: string | null;
}

export interface ProjectActivityOptions {
  limit: number;
  agentNames: Map<string, string>;
  userNames?: Map<string, string>;
  /** Ask text per linked run id (delegation entries), from runs.metadata.input. */
  askByRunId?: Map<string, string | null>;
}

const name = (map: Map<string, string>, id: string | null): string | null =>
  id != null ? (map.get(id) ?? null) : null;

/** A run recorded by the delegation relay — represented by its delegation entry instead. */
function isDelegationRun(run: ActivityRunRow): boolean {
  return typeof run.metadata?.delegationId === "string";
}

/**
 * Merge the per-source rows into one newest-first page. Delegation-linked runs are
 * suppressed (the delegation entry IS that exchange — two rows for one ask would double
 * every sam → ivy beat).
 */
export function projectActivity(
  sources: ActivitySources,
  opts: ProjectActivityOptions,
): ActivityPage {
  const { agentNames, userNames = new Map(), askByRunId = new Map() } = opts;
  const events: ActivityEvent[] = [];

  for (const s of sources.sessions) {
    events.push({
      type: "session",
      id: `session:${s.id}`,
      at: s.createdAt.toISOString(),
      sessionId: s.id,
      agentName: name(agentNames, s.agentId),
      openedByUserName: name(userNames, s.createdBy),
      openedByAgentName: name(agentNames, s.openedByAgentId),
      title: s.title,
    });
  }
  for (const d of sources.delegations) {
    const settled = d.status === "completed" || d.status === "failed";
    events.push({
      type: "delegation",
      id: `delegation:${d.id}`,
      at: d.startedAt.toISOString(),
      delegationId: d.id,
      fromAgentName: name(agentNames, d.fromAgentId),
      toAgentName: name(agentNames, d.toAgentId),
      status: d.status,
      ask: d.runId != null ? (askByRunId.get(d.runId) ?? null) : null,
      error: d.error,
      finishedAt: settled && d.finishedAt ? d.finishedAt.toISOString() : null,
    });
  }
  for (const r of sources.runs) {
    if (isDelegationRun(r)) continue;
    const input = r.metadata?.input;
    events.push({
      type: "run",
      id: `run:${r.id}`,
      at: r.startedAt.toISOString(),
      runId: r.id,
      agentName: name(agentNames, r.agentId),
      channel: r.channel,
      status: r.status,
      input: typeof input === "string" ? input : null,
      error: r.error,
    });
  }
  for (const dep of sources.deployments) {
    events.push({
      type: "deployment",
      id: `deployment:${dep.id}`,
      at: dep.createdAt.toISOString(),
      deploymentId: dep.id,
      agentName: name(agentNames, dep.agentId),
      status: dep.status,
      version: dep.version,
    });
  }

  // Newest first; id tiebreak keeps equal-timestamp order stable across refetches.
  events.sort((a, b) => (a.at === b.at ? (a.id < b.id ? -1 : 1) : a.at < b.at ? 1 : -1));
  const page = events.slice(0, opts.limit);
  // A full page may have older rows behind it (each source was SQL-limited); a short page
  // proves every source ran dry below the cursor.
  const nextBefore = page.length === opts.limit ? page[page.length - 1].at : null;
  return { events: page, nextBefore };
}

/** One beat of an expanded delegation exchange (from run_steps rows). */
export type ExchangeStep =
  | { kind: "message"; role: "user" | "assistant"; text: string }
  | { kind: "tool"; toolName: string | null; summary: string | null; isError: boolean }
  | { kind: "error"; text: string };

export interface ExchangeStepRow {
  seq: number;
  type: string;
  toolName: string | null;
  isError: boolean;
  data: Record<string, unknown> | null;
}

/**
 * Project run_steps into the readable exchange: messages + tool calls (+ failed model
 * beats), dropping quiet model_call/reasoning rows. Pure, ordered by seq.
 */
export function summarizeExchangeSteps(rows: ExchangeStepRow[]): ExchangeStep[] {
  const steps: ExchangeStep[] = [];
  for (const row of [...rows].sort((a, b) => a.seq - b.seq)) {
    const data = row.data ?? {};
    if (row.type === "message") {
      const role = data.role === "user" ? "user" : "assistant";
      const text = typeof data.text === "string" ? data.text : "";
      if (text) steps.push({ kind: "message", role, text });
    } else if (row.type === "tool_call") {
      steps.push({
        kind: "tool",
        toolName: row.toolName,
        summary: typeof data.summary === "string" ? data.summary : null,
        isError: row.isError,
      });
    } else if (row.isError) {
      const text = typeof data.message === "string" ? data.message : "step failed";
      steps.push({ kind: "error", text });
    }
  }
  return steps;
}
