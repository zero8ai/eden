/**
 * Resource route behind the Quick deploy button in the tab row (AgentNav). Owns shipping so the
 * button lives in the shared nav without threading ship data/actions through every repo route's
 * loader — the same self-fetch pattern the staged-changes pill uses (PRD §7.3/§7.7).
 *
 * Quick deploy short-circuits ONLY the staged-changes path: it never ships the branch head. So its
 * data is scope-independent — the button ships ALL of the project's staged drafts no matter which
 * page/level it is clicked from. And because the TEAM is the deployment unit, a ship always moves
 * the whole roster: there is no "who deploys" question. The GET returns the file breakdown grouped
 * by owner (+ shared), the roster (for the "will deploy" list), and the team env names (for the
 * env picker). Any read failure — or a repo that isn't connected — returns an empty payload so the
 * button simply hides; a pill in the shared nav must never crash a page.
 *
 * POST publishes the staged drafts → merges → cuts a version → deploys the WHOLE team into the
 * chosen environment, then redirects to the scope's Overview with the `?shipped=…` params the
 * existing ShipProgress banner reads. There is no branch-head fallback: a POST with nothing staged
 * returns a clean error. The optional `agent` field is used ONLY to build the redirect target, so
 * the user lands back on the Overview they came from.
 */
import { getSessionAuth, sessionLoader } from "~/auth/session.server";
import {
  redirect,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { groupDrafts, type DraftGroup } from "~/deploy/quick-deploy";
import { listTeamEnvNames } from "~/deploy/environments.server";
import { shipStagedChanges } from "~/deploy/ship.server";
import { listDrafts } from "~/drafts/drafts.server";
import { ensureWorkerStarted } from "~/jobs/worker.server";
import { contextPath } from "~/lib/paths";
import { resolveAgentContext } from "~/project/agent-context.server";
import { requireProject, requireRepo } from "~/project/guard.server";

interface QuickDeployData {
  /** Total staged drafts — the button hides at 0, and titles the dialog. */
  draftCount: number;
  /** File breakdown for the dialog: one block per owning member, shared (member null) last. */
  groups: DraftGroup[];
  /** The roster names — the whole team redeploys together, so this is the "will deploy" list. */
  members: string[];
  /** The team's environment names — the deploy target picker (team-level, not per member). */
  envNames: string[];
}

const EMPTY: QuickDeployData = {
  draftCount: 0,
  groups: [],
  members: [],
  envNames: [],
};

export const loader = (args: LoaderFunctionArgs) =>
  sessionLoader(
    args,
    async ({ auth }): Promise<QuickDeployData> => {
      const project = await requireProject(auth, args.params.projectId);
      // No connected repo → nothing to ship; hide the button rather than error the whole page.
      if (
        !project.repoInstallationId ||
        !project.repoOwner ||
        !project.repoName
      ) {
        return EMPTY;
      }
      try {
        const drafts = await listDrafts(project.id);
        // Nothing staged → the button hides (Quick deploy only ships the staged path).
        if (drafts.length === 0) return EMPTY;
        // resolveAgentContext's roster is members-only, so the "will deploy" list and the file
        // breakdown are both roster-scoped for free. Env names are team-level.
        const { roster } = await resolveAgentContext(project.id, null);
        const envNames = await listTeamEnvNames(project.id);
        return {
          draftCount: drafts.length,
          groups: groupDrafts(drafts, roster),
          members: roster.map((m) => m.name),
          envNames,
        };
      } catch {
        // A roster/env lookup blew up — hide the button, don't take the page down with it.
        return EMPTY;
      }
    },
    { ensureSignedIn: true },
  );

export async function action(args: ActionFunctionArgs) {
  const auth = await getSessionAuth(args);
  if (!auth.user) throw redirect("/login");
  const project = requireRepo(
    await requireProject(auth, args.params.projectId),
  );

  const form = await args.request.formData();
  // No fallback name: environments are user-defined (M5.7), so a missing field is a bug to
  // surface, not something to paper over with a guessed target.
  const envName = String(form.get("env") ?? "").trim();
  if (!envName) return { error: "Pick an environment to deploy to." };
  // Redirect-only: the ship always publishes ALL project drafts; `agent` just decides which
  // Overview (repo landing vs. a member's) the user returns to.
  const agent = String(form.get("agent") ?? "").trim() || null;

  try {
    ensureWorkerStarted();
    // Quick deploy ships the staged path only — no branch-head fallback. Check explicitly so an
    // empty stage gets a clean message (shipStagedChanges would also throw, but less specifically).
    const drafts = await listDrafts(project.id);
    if (drafts.length === 0) return { error: "Nothing staged to deploy." };
    // Publish/merge/release run synchronously (same as the Deployment publish button); the build
    // + deploy are queued, and the redirect's ?shipped drives the progress banner on Overview.
    // shipStagedChanges now deploys the WHOLE team into envName — no member subset.
    const result = await shipStagedChanges({
      project,
      envName,
      createdBy: auth.user.id,
    });

    const qs = new URLSearchParams();
    qs.set("shipped", result.gitSha);
    qs.set("env", envName);
    if (result.skipped.length > 0) {
      qs.set("skipped", result.skipped.map((s) => s.agentName).join(","));
    }
    throw redirect(`${contextPath(project.id, agent)}?${qs.toString()}`);
  } catch (error) {
    if (error instanceof Response) throw error;
    return { error: (error as Error).message };
  }
}
