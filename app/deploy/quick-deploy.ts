/**
 * Pure logic behind the Quick deploy button (the always-visible tab-row deploy, PRD §7.3/§7.7).
 *
 * Quick deploy has ONE job: short-circuit the staged-changes path — publish the project's staged
 * drafts, merge, cut a version, and deploy the WHOLE team into one environment (never the branch
 * head, never a subset of members). Because the team is the deployment unit, there is no "who
 * deploys" question: every member redeploys together, and the env NAME set is team-level. The one
 * thing left to compute is the file breakdown grouped by owner (+ shared), so the confirmation
 * dialog can show what will change. That stays a plain function (no auth/DB/GitHub to mock) so the
 * resource route stays thin and it's unit-tested.
 */
import type { DraftChange } from "~/data/ports";

/** One block in the dialog's file breakdown: a member's drafts, or the shared (unattributed) set. */
export interface DraftGroup {
  /** Owning member's name, or null for shared drafts (agentId null — e.g. root package.json). */
  member: string | null;
  files: string[];
}

/**
 * Group the staged drafts for the dialog's file breakdown: one block per member that owns drafts
 * (in roster order), then a trailing shared block (agentId null) when any unattributed drafts
 * exist. Members with no drafts are omitted; file order is preserved within each group. Drafts are
 * attributed to roster members by agentId, so the breakdown names match the roster the user sees.
 */
/**
 * Should the confirmation dialog close itself after a ship attempt? The success path redirects to
 * the scope's Overview, but AgentNav (and therefore the dialog) lives in the project layout that
 * the redirect usually lands back on — the component never unmounts, so the dialog can't rely on
 * unmounting to dismiss. Instead it watches the ship fetcher: a transition from in-flight back to
 * idle WITHOUT an error payload means the action redirected (success) — close so the ShipProgress
 * banner underneath is visible. An error keeps the dialog open for retry/cancel. Pure so the
 * transition semantics are unit-testable without a DOM.
 */
export function shouldCloseAfterShip(args: {
  /** Was the ship fetcher in flight (submitting/loading) on the previous render? */
  wasDeploying: boolean;
  /** Is it in flight now? */
  deploying: boolean;
  /** The action's { error } payload, if it returned one instead of redirecting. */
  error: string | undefined;
}): boolean {
  return args.wasDeploying && !args.deploying && !args.error;
}

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
