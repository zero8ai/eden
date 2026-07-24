/**
 * Invite-to-repo (FOH invites & roles — the portal replacement). A back-of-house admin invites
 * an email to ONE repo: the org invitation carries the repo team's id, so accepting it makes
 * the recipient a workspace `member` scoped to this repo in front of house (Better Auth
 * auto-adds the invitee to `invitation.teamId` on accept).
 *
 * GET  → this repo's pending team invitations (for the dialog's list).
 * POST intent=invite → ensure the repo team exists, then send the invitation.
 *
 * requireProject is the admin gate: after D10 it rejects front-of-house members outright.
 */
import {
  redirect,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { getSessionAuth, sessionLoader } from "~/auth/session.server";
import { ensureProjectTeam } from "~/auth/teams.server";
import { requireProject } from "~/project/guard.server";
import { auth as betterAuth } from "~/lib/auth.server";
import { publicAuthErrorMessage } from "~/lib/auth-error.server";
import { recordAudit } from "~/managed/audit.server";

/** Better Auth stores multi-team invitations comma-separated; match any segment. */
function invitationTargetsTeam(
  invitationTeamId: string | null | undefined,
  teamId: string,
): boolean {
  return Boolean(
    invitationTeamId?.split(",").some((part) => part.trim() === teamId),
  );
}

export const loader = (args: LoaderFunctionArgs) =>
  sessionLoader(
    args,
    async ({ auth }) => {
      const project = await requireProject(auth, args.params.projectId);
      const teamId = project.teamId;
      if (!teamId) return { invites: [] };
      const invitations = await betterAuth.api.listInvitations({
        query: { organizationId: project.orgId },
        headers: auth.requestHeaders,
      });
      return {
        invites: invitations.flatMap((invitation) =>
          invitation.status === "pending" &&
          invitationTargetsTeam(invitation.teamId, teamId)
            ? [
                {
                  id: invitation.id,
                  email: invitation.email,
                  expiresAt: invitation.expiresAt.toISOString(),
                },
              ]
            : [],
        ),
      };
    },
    { ensureSignedIn: true },
  );

export async function action(args: ActionFunctionArgs) {
  const auth = await getSessionAuth(args);
  if (!auth.user) throw redirect("/login");
  const project = await requireProject(auth, args.params.projectId);

  const form = await args.request.formData();
  const intent = String(form.get("intent") ?? "invite");
  if (intent !== "invite") return { error: "Unknown action." };

  const email = String(form.get("email") ?? "")
    .trim()
    .toLowerCase();
  if (!email || !email.includes("@"))
    return { error: "Enter a valid email address." };

  let teamId: string;
  try {
    teamId = await ensureProjectTeam(project.orgId, project);
  } catch {
    return { error: "Could not prepare this repository's team." };
  }

  try {
    // Invitees join with the member role — front of house only, scoped to this repo's team.
    await betterAuth.api.createInvitation({
      body: {
        email,
        role: "member",
        organizationId: project.orgId,
        teamId,
        // A lapsed or duplicate pending invite re-sends instead of erroring (org.members
        // resend-invite precedent) — the dialog has no separate resend control.
        resend: true,
      },
      headers: auth.requestHeaders,
    });
  } catch (error) {
    return {
      error: publicAuthErrorMessage(error, "Could not send the invitation."),
    };
  }

  await recordAudit({
    orgId: project.orgId,
    actorUserId: auth.user.id,
    action: "member_invited",
    target: email,
    meta: { projectId: project.id, teamId },
  });
  return { ok: true as const };
}
