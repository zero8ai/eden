/**
 * Resource route behind the staged-changes pill in the tab row (AgentNav). Returns the
 * staged-draft count for the CURRENT scope: `?agent=<name>` counts that member's drafts
 * plus shared (unattributed) ones — the same set its Deployment tab shows — while no
 * param counts the whole repo (team landing, single-agent repos).
 *
 * A resource route (not loader data threaded through every page) so the pill can live in
 * the shared nav without touching each route's loader; the client fetcher revalidates it
 * after every action, which is what keeps the count honest as drafts stage and publish.
 */
import { authkitLoader } from "@workos-inc/authkit-react-router";
import type { LoaderFunctionArgs } from "react-router";

import { listDrafts } from "~/drafts/drafts.server";
import { resolveAgentContext } from "~/project/agent-context.server";
import { requireProject } from "~/project/guard.server";

export const loader = (args: LoaderFunctionArgs) =>
  authkitLoader(
    args,
    async ({ auth }) => {
      const project = await requireProject(
        {
          user: auth.user,
          organizationId: auth.organizationId,
          role: auth.role,
        },
        args.params.projectId,
      );
      const agentName = new URL(args.request.url).searchParams.get("agent");
      const drafts = await listDrafts(project.id);
      if (!agentName) return { count: drafts.length };
      const { active } = await resolveAgentContext(project.id, agentName);
      return {
        count: drafts.filter(
          (d) => d.agentId === active.id || d.agentId === null,
        ).length,
      };
    },
    { ensureSignedIn: true },
  );
