/**
 * Share an agent (issue #180) — the data endpoint behind the "Share" dialog in the agent nav.
 * "Portals" are hidden here: an agent has one canonical portal, auto-provisioned on the first
 * invite. GET returns the current access list; POST invites (grant + email a one-click magic
 * link) or revokes. Kept as a resource route so the dialog works from any agent screen without
 * coupling to a single page's loader.
 */
import { data, redirect } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { getSessionAuth } from "~/auth/session.server";
import { auth } from "~/lib/auth.server";
import {
  findAgentPortal,
  getOrCreatePortalForAgent,
  listGrants,
  revokeGrant,
  upsertGrant,
} from "~/portal/portals.server";
import { resolveAgentContext } from "~/project/agent-context.server";
import { requireProject, requireRepo } from "~/project/guard.server";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Resolve the agent the Share dialog targets. The nav only knows the member name (or nothing, for
 * a single-agent repo), so we key on name and fall back to the sole agent — matching the surfaces
 * where Share appears. A team repo with no member selected has no single agent to share.
 */
async function requireAgent(projectId: string, agentName: string | null) {
  const { roster } = await resolveAgentContext(projectId, null);
  const agent = agentName
    ? roster.find((a) => a.name === agentName)
    : roster.length === 1
      ? roster[0]
      : null;
  if (!agent) throw data({ error: "Unknown agent." }, { status: 404 });
  return agent;
}

export async function loader(args: LoaderFunctionArgs) {
  const session = await getSessionAuth(args);
  if (!session.user) throw redirect("/login");
  const project = requireRepo(
    await requireProject(session, args.params.projectId, {
      request: args.request,
    }),
  );
  const agentName =
    new URL(args.request.url).searchParams.get("agentName") || null;
  const agent = await requireAgent(project.id, agentName);
  const portal = await findAgentPortal({
    projectId: project.id,
    agentId: agent.id,
  });
  const grants = portal ? await listGrants(portal.id) : [];
  return {
    agentName: agent.name,
    portalSlug: portal?.slug ?? null,
    people: grants
      .filter((g) => g.revokedAt === null)
      .map((g) => ({ id: g.id, email: g.email })),
  };
}

export async function action(args: ActionFunctionArgs) {
  const session = await getSessionAuth(args);
  if (!session.user) throw redirect("/login");
  const project = requireRepo(
    await requireProject(session, args.params.projectId),
  );
  const form = await args.request.formData();
  const intent = String(form.get("intent"));
  const agentName = String(form.get("agentName") ?? "") || null;
  const agent = await requireAgent(project.id, agentName);

  if (intent === "invite") {
    const email = String(form.get("email") ?? "")
      .trim()
      .toLowerCase();
    if (!EMAIL_RE.test(email)) {
      return { error: "Enter a valid email address." };
    }
    // Grant first so the magicLink send callback's live-grant check passes for this email.
    const portal = await getOrCreatePortalForAgent({
      projectId: project.id,
      agentId: agent.id,
      agentName: agent.name,
      createdBy: session.user.id,
    });
    await upsertGrant({
      portalId: portal.id,
      email,
      invitedBy: session.user.id,
    });
    try {
      await auth.api.signInMagicLink({
        body: { email, callbackURL: `/a/${portal.slug}` },
        headers: args.request.headers,
      });
    } catch (error) {
      console.error(
        `Could not send a portal share link (${(error as Error)?.name ?? "Error"}).`,
      );
      return {
        ok: true as const,
        warning:
          "Access granted, but the invite email could not be sent right now.",
      };
    }
    return { ok: true as const };
  }

  if (intent === "revoke") {
    const grantId = String(form.get("grantId") ?? "");
    const portal = await findAgentPortal({ projectId: project.id, agentId: agent.id });
    if (portal && grantId) {
      await revokeGrant({ portalId: portal.id, grantId });
    }
    return { ok: true as const };
  }

  throw data({ error: "Unknown action." }, { status: 400 });
}
