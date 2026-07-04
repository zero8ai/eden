/**
 * Canonical client paths for the repository hierarchy (shared client/server). Every route
 * builds links through these so a future URL rename is a one-file change — the 2026-07
 * "projects" → "repos" rename swept a dozen files precisely because this didn't exist.
 *
 * The hierarchy is two-level (M5.8): repo pages live at /repos/:id/..., a team member's
 * pages at /repos/:id/agents/:name/... — single-agent repos collapse to the repo level (the
 * repo IS the agent; no /agents segment ever appears for them).
 */

/** Base path for one repository's pages. */
export function repoPath(projectId: string): string {
  return `/repos/${projectId}`;
}

/**
 * Base path for the current working context: a member's pages when a team member is
 * selected, the repo's pages otherwise (single-agent repos, or the team landing).
 */
export function contextPath(
  projectId: string,
  agentName?: string | null,
): string {
  return agentName
    ? `/repos/${projectId}/agents/${encodeURIComponent(agentName)}`
    : `/repos/${projectId}`;
}
