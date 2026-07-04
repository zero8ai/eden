/**
 * Canonical client paths for the repository hierarchy (shared client/server). Every route
 * builds links through these so a future URL rename is a one-file change — the 2026-07
 * "projects" → "repos" rename swept a dozen files precisely because this didn't exist.
 */

/** Base path for one repository's pages. */
export function repoPath(projectId: string): string {
  return `/repos/${projectId}`;
}

/** Query suffix that pins a team member across tabs ("" for teams of one). */
export function agentQuery(agentName: string | null | undefined, isTeam: boolean): string {
  return isTeam && agentName ? `?agent=${encodeURIComponent(agentName)}` : "";
}
