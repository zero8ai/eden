/**
 * Resource route behind the Quick deploy button in the tab row (AgentNav). Owns shipping so the
 * button lives in the shared nav without threading ship data/actions through every repo route's
 * loader — the same self-fetch pattern the staged-changes pill uses (PRD §7.3/§7.7).
 *
 * GET returns the button's data for the CURRENT scope: the environments it can ship to and
 * whether anything is staged. `?agent=<name>` scopes to one member (its envs, its drafts +
 * shared); no param is the whole repo (team landing / single-agent repo), where envs are the
 * de-duplicated union across the roster. Any read failure returns an empty env list so the
 * button simply hides — a pill in the shared nav must never crash a page.
 *
 * POST runs the whole Ship pipeline (publish staged drafts → merge → cut version → deploy, or
 * ship the branch head when nothing is staged), then redirects to the scope's Overview with the
 * `?shipped=…` params the existing ShipProgress banner reads. Staged-vs-head is decided
 * SERVER-SIDE here (never from the client's possibly-stale draftCount).
 */
import { authkitLoader, withAuth } from "@workos-inc/authkit-react-router";
import { redirect, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";

import { listAgentEnvironments } from "~/db/queries.server";
import { draftsInScope, unionEnvNames } from "~/deploy/quick-deploy";
import { shipHead, shipStagedChanges } from "~/deploy/ship.server";
import { listDrafts } from "~/drafts/drafts.server";
import { ensureWorkerStarted } from "~/jobs/worker.server";
import { contextPath } from "~/lib/paths";
import { resolveAgentContext } from "~/project/agent-context.server";
import { requireProject, requireRepo } from "~/project/guard.server";

interface QuickDeployData {
  /** Environment names the button offers, in ship-priority order (primary first). */
  envNames: string[];
  /** Staged drafts in scope — decides the button's label, not the server's staged-vs-head choice. */
  draftCount: number;
  defaultBranch: string;
}

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
      const empty: QuickDeployData = {
        envNames: [],
        draftCount: 0,
        defaultBranch: project.defaultBranch,
      };
      // No connected repo → nothing to ship; hide the button rather than error the whole page.
      if (!project.repoInstallationId || !project.repoOwner || !project.repoName) {
        return empty;
      }
      try {
        const agentName = new URL(args.request.url).searchParams.get("agent");
        const drafts = await listDrafts(project.id);
        if (agentName) {
          // Member scope: this member's envs (creation order = primary first) and its own +
          // shared drafts.
          const { active } = await resolveAgentContext(project.id, agentName);
          const envs = await listAgentEnvironments(active.id);
          return {
            envNames: envs.map((e) => e.name),
            draftCount: draftsInScope(drafts, active.id).length,
            defaultBranch: project.defaultBranch,
          };
        }
        // Repo scope: the ordered de-duplicated union of env names across the whole roster.
        const { roster } = await resolveAgentContext(project.id, null);
        const perMember = await Promise.all(
          roster.map(async (a) => (await listAgentEnvironments(a.id)).map((e) => e.name)),
        );
        return {
          envNames: unionEnvNames(perMember),
          draftCount: drafts.length,
          defaultBranch: project.defaultBranch,
        };
      } catch {
        // A roster/env lookup blew up — hide the button, don't take the page down with it.
        return empty;
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
  const agent = String(form.get("agent") ?? "").trim() || null;

  try {
    ensureWorkerStarted();
    // Decide staged-vs-head here, at POST time, from the live drafts — never trust the client's
    // stale draftCount. The scope filter only chooses the path; shipStagedChanges still publishes
    // ALL project drafts (matching the old member-level Ship dialog), the filter just answers
    // "is there anything staged for this scope to ship?".
    const drafts = await listDrafts(project.id);
    const activeId = agent
      ? (await resolveAgentContext(project.id, agent)).active.id
      : null;
    const staged = draftsInScope(drafts, activeId);
    // Publish/merge/release run synchronously (same as the Deployment publish button); the build
    // + deploy are queued, and the redirect's ?shipped drives the progress banner on Overview.
    const result =
      staged.length > 0
        ? await shipStagedChanges({ project, envName, createdBy: auth.user.id })
        : await shipHead({ project, envName, createdBy: auth.user.id });

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
