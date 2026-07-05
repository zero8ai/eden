/**
 * Active-agent resolution for project routes (Teams, PRD §7.9; hierarchy M5.8). Member
 * context is a URL level — `/repos/:id/agents/:name/...` — with its own tab row; repo-level
 * pages have no member segment. Single-agent repos are teams of one: the levels collapse,
 * `active` is simply the only member, and no `/agents/...` path ever appears.
 */
import { data, redirect } from "react-router";

import type { Agent, DataStore } from "~/data/ports";
import {
  listAgents,
  syncProjectAgents,
  withPreservedNames,
} from "~/db/queries.server";
import { detectAgentRoots } from "~/eve/parse";

export interface AgentContext {
  /** The project's full roster, by name. */
  roster: Agent[];
  /** The member the current request operates on. */
  active: Agent;
  /** True when the repo uses the `agents/<member>/agent` team layout. */
  isTeam: boolean;
}

function isTeamRoster(roster: Agent[]): boolean {
  return roster.some((a) => a.root !== "agent");
}

function rosterMatches(
  roster: Agent[],
  detected: { name: string; root: string }[],
): boolean {
  const known = new Set(roster.map((a) => `${a.name}:${a.root}`));
  return (
    detected.length === roster.length &&
    detected.every((d) => known.has(`${d.name}:${d.root}`))
  );
}

/** Resolve the roster + active member from a member name/id (or a form's `agent` field). */
export async function resolveAgentContext(
  projectId: string,
  agentName: string | null,
  store?: DataStore,
): Promise<AgentContext> {
  const roster = await listAgents(projectId, store);
  if (roster.length === 0) {
    // Pre-split projects that never re-synced; connect/webhook normally prevent this.
    throw data("Project has no agents — reconnect the repository.", { status: 500 });
  }
  const active = roster.find((a) => a.name === agentName || a.id === agentName) ?? roster[0];
  return { roster, active, isTeam: isTeamRoster(roster) };
}

/**
 * Resolve context after reconciling the stored roster with a freshly-read repo tree, so external
 * pushes/webhook misses do not leave Eden classifying a team-layout repo as a single-agent repo.
 */
export async function resolveSyncedAgentContext(
  projectId: string,
  agentName: string | null,
  paths: string[],
  store?: DataStore,
): Promise<AgentContext> {
  const ctx = await resolveAgentContext(projectId, agentName, store);
  const detected = withPreservedNames(ctx.roster, detectAgentRoots(paths));
  if (detected.length === 0 || rosterMatches(ctx.roster, detected)) {
    return ctx;
  }
  await syncProjectAgents(projectId, detected, store);
  return resolveAgentContext(projectId, agentName, store);
}

/** The member selector for a route: the `:agentName` path segment (auto URL-decoded). */
export function agentFromParams(params: { agentName?: string }): string | null {
  return params.agentName ?? null;
}

/**
 * Legacy `?agent=<name>` links (pre-M5.8) 301 into the member path, preserving the tab and
 * any other query params. Call at the top of repo-level loaders; null when nothing to do.
 */
export function agentParamRedirect(
  request: Request,
  projectId: string,
): Response | null {
  const url = new URL(request.url);
  const agent = url.searchParams.get("agent");
  if (!agent) return null;
  url.searchParams.delete("agent");
  const tab = url.pathname.replace(/^\/repos\/[^/]+\/?/, "");
  return redirect(
    `/repos/${projectId}/agents/${encodeURIComponent(agent)}${tab ? `/${tab}` : ""}${url.search}`,
    301,
  );
}

/** The member name a repo path implies ("agents/<m>/agent/…" → "<m>"), or null. */
export function memberFromPath(path: string): string | null {
  const m = path.match(/^agents\/([^/]+)\//);
  return m ? m[1] : null;
}
