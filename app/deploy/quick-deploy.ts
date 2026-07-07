/**
 * Pure scope logic behind the Quick deploy button (the always-visible tab-row deploy, PRD
 * §7.3/§7.7). The button appears at every hierarchy level, so its data — which environments
 * it can ship to, and whether anything is staged — is computed differently for a single member
 * than for a whole team roster. These helpers hold that difference as plain functions so the
 * resource route stays thin and the branching stays unit-tested (no auth/DB/GitHub to mock).
 */
import type { DraftChange } from "~/data/ports";

/**
 * The ordered, de-duplicated union of environment names across a team roster. Environments are
 * per-agent and user-defined (M5.7), so a team's members can expose different names — the button
 * offers the SUPERSET (a ship into a name simply skips members that lack it, exactly like the
 * ship pipeline does). Ordering is first-seen: iterate the roster in order, each member's envs in
 * creation order (primary first), and keep the first position a name appears at — so a member's
 * primary tends to lead, matching the single-member case where the primary is the default target.
 */
export function unionEnvNames(perMemberEnvNames: string[][]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const names of perMemberEnvNames) {
    for (const name of names) {
      if (seen.has(name)) continue;
      seen.add(name);
      ordered.push(name);
    }
  }
  return ordered;
}

/**
 * The drafts that belong to a scope. Member scope (`activeId` set) is that member's own drafts
 * plus shared/unattributed ones (agentId null — e.g. root package.json affects everyone) — the
 * same set the member's Deployment tab and staged-count pill show. Repo scope (`activeId` null)
 * is every draft. Only used to decide staged-vs-head; publishing still ships all project drafts.
 */
export function draftsInScope(
  drafts: DraftChange[],
  activeId: string | null,
): DraftChange[] {
  if (activeId === null) return drafts;
  return drafts.filter((d) => d.agentId === activeId || d.agentId === null);
}
