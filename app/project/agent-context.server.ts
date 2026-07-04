/**
 * Active-agent resolution for project routes (Teams, PRD §7.9). Every project tab operates
 * on ONE roster member at a time; `?agent=<name>` selects it and the tab nav preserves it.
 * Single-agent repos are teams of one, so the switcher never appears and `active` is simply
 * the only member — the pre-teams UX is unchanged.
 */
import { data } from "react-router";

import type { Agent } from "~/data/ports";
import { listAgents } from "~/db/queries.server";

export interface AgentContext {
  /** The project's full roster, by name. */
  roster: Agent[];
  /** The member the current request operates on. */
  active: Agent;
  /** True when the roster has more than one member (render the switcher). */
  isTeam: boolean;
}

/** Resolve the roster + active member from `?agent=<name>` (or a form's `agent` field). */
export async function resolveAgentContext(
  projectId: string,
  agentName: string | null,
): Promise<AgentContext> {
  const roster = await listAgents(projectId);
  if (roster.length === 0) {
    // Pre-split projects that never re-synced; connect/webhook normally prevent this.
    throw data("Project has no agents — reconnect the repository.", { status: 500 });
  }
  const active = roster.find((a) => a.name === agentName || a.id === agentName) ?? roster[0];
  return { roster, active, isTeam: roster.length > 1 };
}

/** Convenience: pull the `agent` selector from a request URL. */
export function agentParam(request: Request): string | null {
  return new URL(request.url).searchParams.get("agent");
}

/** The member name a repo path implies ("agents/<m>/agent/…" → "<m>"), or null. */
export function memberFromPath(path: string): string | null {
  const m = path.match(/^agents\/([^/]+)\//);
  return m ? m[1] : null;
}
