/**
 * Resource route behind the Quick deploy button in the tab row (AgentNav). Owns shipping so the
 * button lives in the shared nav without threading ship data/actions through every repo route's
 * loader — the same self-fetch pattern the staged-changes pill uses (PRD §7.3/§7.7).
 *
 * Quick deploy short-circuits ONLY the staged-changes path: it never ships the branch head. So its
 * data is scope-independent — the button ships ALL of the project's staged drafts no matter which
 * page/level it is clicked from. The GET therefore drops per-member scoping and returns everything
 * the confirmation dialog needs to be honest before the user commits: the file breakdown grouped
 * by owner (+ shared), and the expanded "who deploys" set with each affected member's own env
 * names (for the target union and the per-member "no environment named X" warnings). Any read
 * failure — or a repo that isn't connected — returns an empty payload so the button simply hides;
 * a pill in the shared nav must never crash a page.
 *
 * POST publishes the staged drafts → merges → cuts a version → deploys the affected members, then
 * redirects to the scope's Overview with the `?shipped=…` params the existing ShipProgress banner
 * reads. There is no branch-head fallback: a POST with nothing staged returns a clean error. The
 * optional `agent` field is used ONLY to build the redirect target, so the user lands back on the
 * Overview they came from.
 */
import { authkitLoader, withAuth } from "@workos-inc/authkit-react-router";
import { redirect, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";

import { listAgentEnvironments } from "~/db/queries.server";
import { affectedMembers, groupDrafts, type DraftGroup } from "~/deploy/quick-deploy";
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
  /**
   * The members this ship will deploy (shared drafts expand to the whole roster), each with its
   * own environment names — drives the target union, the static-vs-Select choice, and the
   * per-member env-mismatch warnings.
   */
  affected: { name: string; envNames: string[] }[];
}

const EMPTY: QuickDeployData = { draftCount: 0, groups: [], affected: [] };

export const loader = (args: LoaderFunctionArgs) =>
  authkitLoader(
    args,
    async ({ auth }): Promise<QuickDeployData> => {
      const project = await requireProject(
        {
          user: auth.user,
          organizationId: auth.organizationId,
          role: auth.role,
        },
        args.params.projectId,
      );
      // No connected repo → nothing to ship; hide the button rather than error the whole page.
      if (!project.repoInstallationId || !project.repoOwner || !project.repoName) {
        return EMPTY;
      }
      try {
        const drafts = await listDrafts(project.id);
        // Nothing staged → the button hides (Quick deploy only ships the staged path).
        if (drafts.length === 0) return EMPTY;
        const { roster } = await resolveAgentContext(project.id, null);
        const affected = await Promise.all(
          affectedMembers(drafts, roster).map(async (member) => ({
            name: member.name,
            envNames: (await listAgentEnvironments(member.id)).map((e) => e.name),
          })),
        );
        return {
          draftCount: drafts.length,
          groups: groupDrafts(drafts, roster),
          affected,
        };
      } catch {
        // A roster/env lookup blew up — hide the button, don't take the page down with it.
        return EMPTY;
      }
    },
    { ensureSignedIn: true },
  );

export async function action(args: ActionFunctionArgs) {
  const auth = await withAuth(args);
  if (!auth.user) throw redirect("/login");
  const project = requireRepo(
    await requireProject(
      {
        user: auth.user,
        organizationId: auth.organizationId ?? null,
        role: auth.role ?? null,
      },
      args.params.projectId,
    ),
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
