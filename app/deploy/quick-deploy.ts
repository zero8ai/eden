/**
 * Pure logic behind the Quick deploy button (the always-visible tab-row deploy, PRD §7.3/§7.7).
 *
 * Quick deploy has ONE job: short-circuit the staged-changes path — publish the project's staged
 * drafts, merge, cut a version, and deploy the AFFECTED members (never the branch head, never the
 * whole roster to "latest"). The confirmation dialog it opens needs to tell the user, before they
 * commit, exactly what will happen: which files change and who owns them, who gets redeployed, and
 * which target environment. These helpers compute that transparency as plain functions (no
 * auth/DB/GitHub to mock) so the resource route stays thin and the branching stays unit-tested.
 */
import type { DraftChange } from "~/data/ports";

/** One block in the dialog's file breakdown: a member's drafts, or the shared (unattributed) set. */
export interface DraftGroup {
  /** Owning member's name, or null for shared drafts (agentId null — e.g. root package.json). */
  member: string | null;
  files: string[];
}

/**
 * The ordered, de-duplicated union of environment names across a set of members. Environments are
 * per-agent and user-defined (M5.7), so affected members can expose different names — the dialog
 * offers the SUPERSET (a ship into a name simply skips members that lack it, exactly like the ship
 * pipeline does). Ordering is first-seen: iterate members in order, each member's envs in creation
 * order (primary first), and keep the first position a name appears at — so a primary tends to
 * lead, matching the single-member case where the primary is the default target.
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
 * Group the staged drafts for the dialog's file breakdown: one block per member that owns drafts
 * (in roster order), then a trailing shared block (agentId null) when any unattributed drafts
 * exist. Members with no drafts are omitted; file order is preserved within each group. Drafts are
 * attributed to roster members by agentId, so the breakdown names match the roster the user sees.
 */
export function groupDrafts(
  drafts: DraftChange[],
  roster: { id: string; name: string }[],
): DraftGroup[] {
  const byId = new Map<string, string[]>();
  const shared: string[] = [];
  for (const d of drafts) {
    if (d.agentId === null) {
      shared.push(d.path);
      continue;
    }
    const files = byId.get(d.agentId) ?? [];
    files.push(d.path);
    byId.set(d.agentId, files);
  }
  const groups: DraftGroup[] = [];
  for (const member of roster) {
    const files = byId.get(member.id);
    if (files && files.length > 0) groups.push({ member: member.name, files });
  }
  if (shared.length > 0) groups.push({ member: null, files: shared });
  return groups;
}

/**
 * The members a ship of these drafts will deploy — the "affected" set. Normally that is only the
 * members that own a draft, but any shared draft (agentId null) expands the set to the WHOLE
 * roster: a shared change (e.g. a root file) rebuilds and redeploys everyone. Roster order is
 * preserved. Mirrors the target selection in shipStagedChanges, kept pure so the dialog can show
 * the same "Will deploy" set the server will act on.
 */
export function affectedMembers<T extends { id: string }>(
  drafts: DraftChange[],
  roster: T[],
): T[] {
  const hasShared = drafts.some((d) => d.agentId === null);
  if (hasShared) return roster;
  const ids = new Set(
    drafts.map((d) => d.agentId).filter((id): id is string => id !== null),
  );
  return roster.filter((member) => ids.has(member.id));
}
