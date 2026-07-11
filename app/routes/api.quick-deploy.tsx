/**
 * Resource route behind the Quick deploy button in the tab row (AgentNav). Owns shipping so the
 * button lives in the shared nav without threading ship data/actions through every repo route's
 * loader — the same self-fetch pattern the staged-changes pill uses (PRD §7.3/§7.7).
 *
 * Quick deploy has two source modes, both team-wide (the TEAM is the deployment unit, so there is
 * never a "who deploys" question). With staged drafts it short-circuits the staged-changes path;
 * with a connected, ready repo and ZERO staged drafts it deploys the branch HEAD directly — a
 * ready repo must deploy in one click without first staging an edit (issue #101). Its data is
 * scope-independent — the source is the whole project, not the page it is clicked from. The GET
 * returns, in staged mode, the file breakdown grouped by owner (+ shared); in HEAD mode, the
 * resolved `headBranch`/`headSha`; plus the roster (for the "will deploy" list) and the team env
 * names (for the env picker). A repo that isn't connected, has no detected members, or whose head
 * is unfetchable returns an empty payload so the UI shows Quick deploy as genuinely unavailable
 * without letting a shared-nav control crash the page.
 *
 * POST deploys the WHOLE team into the chosen environment and redirects to the scope's Overview
 * with the `?shipped=…` params the existing ShipProgress banner reads. The `source` field selects
 * the path: "staged" (default, back-compat) publishes drafts → merges → cuts a version; "head"
 * cuts a version at the branch HEAD with no change-set. The optional `agent` field is used ONLY to
 * build the redirect target, so the user lands back on the Overview they came from.
 */
import { getSessionAuth, sessionLoader } from "~/auth/session.server";
import {
  redirect,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { groupDrafts, type DraftGroup } from "~/deploy/quick-deploy";
import { listTeamEnvNames } from "~/deploy/environments.server";
import { shipRepoHead, shipStagedChanges } from "~/deploy/ship.server";
import { listDrafts } from "~/drafts/drafts.server";
import { getBranchHead } from "~/github/repo.server";
import { ensureWorkerStarted } from "~/jobs/worker.server";
import { contextPath } from "~/lib/paths";
import { resolveAgentContext } from "~/project/agent-context.server";
import { requireProject, requireRepo } from "~/project/guard.server";

interface QuickDeployData {
  /** Total staged drafts — >0 opens the staged dialog; 0 opens HEAD mode when headBranch is set. */
  draftCount: number;
  /** File breakdown for the staged dialog: one block per owning member, shared (member null) last. */
  groups: DraftGroup[];
  /** The roster names — the whole team redeploys together, so this is the "will deploy" list. */
  members: string[];
  /** The team's environment names — the deploy target picker (team-level, not per member). */
  envNames: string[];
  /** HEAD-mode target branch (null in staged mode and when the repo is genuinely undeployable). */
  headBranch: string | null;
  /** HEAD-mode target commit sha (null in staged mode and when the head is unfetchable). */
  headSha: string | null;
}

const EMPTY: QuickDeployData = {
  draftCount: 0,
  groups: [],
  members: [],
  envNames: [],
  headBranch: null,
  headSha: null,
};

export const loader = (args: LoaderFunctionArgs) =>
  sessionLoader(
    args,
    async ({ auth }): Promise<QuickDeployData> => {
      const project = await requireProject(auth, args.params.projectId);
      // No connected repo → nothing to ship; return the unavailable state rather than erroring.
      if (
        !project.repoInstallationId ||
        !project.repoOwner ||
        !project.repoName
      ) {
        return EMPTY;
      }
      try {
        const drafts = await listDrafts(project.id);
        // resolveAgentContext's roster is members-only, so the "will deploy" list and the file
        // breakdown are both roster-scoped for free. Env names are team-level.
        const { roster } = await resolveAgentContext(project.id, null);
        const envNames = await listTeamEnvNames(project.id);
        // Nothing staged → deploy the branch HEAD directly (issue #101). A repo with no detected
        // members is genuinely undeployable, so degrade to unavailable rather than fetching a head
        // no one can receive.
        if (drafts.length === 0) {
          if (roster.length === 0) return EMPTY;
          const { sha, branch } = await getBranchHead(
            project.repoInstallationId,
            {
              owner: project.repoOwner,
              repo: project.repoName,
              ref: project.defaultBranch,
            },
          );
          return {
            draftCount: 0,
            groups: [],
            members: roster.map((m) => m.name),
            envNames,
            headBranch: branch,
            headSha: sha,
          };
        }
        return {
          draftCount: drafts.length,
          groups: groupDrafts(drafts, roster),
          members: roster.map((m) => m.name),
          envNames,
          headBranch: null,
          headSha: null,
        };
      } catch {
        // A roster/env lookup blew up — degrade to unavailable, don't take the page down with it.
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
  // Redirect-only: the ship always moves ALL project members; `agent` just decides which
  // Overview (repo landing vs. a member's) the user returns to.
  const agent = String(form.get("agent") ?? "").trim() || null;
  // Source mode: "head" deploys the branch HEAD with no change-set (issue #101); "staged" (default,
  // back-compat) publishes the staged drafts. The dialog stamps this explicitly.
  const source = String(form.get("source") ?? "staged").trim();

  try {
    ensureWorkerStarted();
    const drafts = await listDrafts(project.id);

    if (source === "head") {
      // Deploying the branch head means there is no change-set to review. If drafts appeared since
      // the dialog opened, HEAD mode would silently ship a change-set the user never saw — refuse
      // and make them reopen into the staged flow.
      if (drafts.length > 0) {
        return {
          error:
            "Changes were staged since you opened this dialog — reopen Quick deploy.",
        };
      }
      const result = await shipRepoHead({
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
    }

    // Staged path — check explicitly so an empty stage gets a clean message (shipStagedChanges
    // would also throw, but less specifically).
    if (drafts.length === 0) return { error: "Nothing staged to deploy." };
    // Publish/merge/release run synchronously (same as the Deployment publish button); the build
    // + deploy are queued, and the redirect's ?shipped drives the progress banner on Overview.
    // shipStagedChanges deploys the WHOLE team into envName — no member subset.
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
