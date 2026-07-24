/**
 * Invite-to-repo (FOH invites & roles — the portal replacement). A back-of-house admin types
 * an email to grant ONE repo; the action branches on who the email already is (issue #221):
 *
 *  - Existing org member → direct Better Auth addTeamMember grant (createInvitation rejects
 *    members outright). This is also the admin REPAIR PATH for pre-team members with no
 *    teamMember rows: typing their email grants the repo immediately.
 *  - Pending invitation for OTHER repos → cancel it and recreate carrying the merged team-id
 *    list (resend:true alone re-sends the OLD invitation and silently drops the new team).
 *  - Pending invitation already targeting this repo → refresh + resend as before.
 *  - New email → plain single-team invitation; accepting makes the recipient a workspace
 *    `member` scoped to this repo (Better Auth auto-adds `invitation.teamId` on accept).
 *
 * GET  → this repo's pending team invitations (for the dialog's list).
 * POST intent=invite → ensure the repo team exists, then grant or invite as above.
 *
 * requireProject is the admin gate: after D10 it rejects front-of-house members outright.
 */
import {
  redirect,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { getSessionAuth, sessionLoader } from "~/auth/session.server";
import {
  addProjectTeamMember,
  ensureProjectTeam,
  findOrgMemberIdByEmail,
} from "~/auth/teams.server";
import { requireProject } from "~/project/guard.server";
import { auth as betterAuth } from "~/lib/auth.server";
import { publicAuthErrorMessage } from "~/lib/auth-error.server";
import { recordAudit } from "~/managed/audit.server";

/** Better Auth stores multi-team invitations comma-separated. */
function splitInvitationTeamIds(
  invitationTeamId: string | null | undefined,
): string[] {
  return (invitationTeamId ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Match any segment of a (possibly multi-team) invitation's team list. */
function invitationTargetsTeam(
  invitationTeamId: string | null | undefined,
  teamId: string,
): boolean {
  return splitInvitationTeamIds(invitationTeamId).includes(teamId);
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

  // Existing org member (any role, including pre-team members with no teamMember rows):
  // createInvitation would reject them, so grant the team directly. addTeamMember checks the
  // caller's member:update permission, hence the admin's session headers.
  const memberUserId = await findOrgMemberIdByEmail(project.orgId, email);
  if (memberUserId) {
    try {
      await addProjectTeamMember({
        orgId: project.orgId,
        teamId,
        userId: memberUserId,
        headers: auth.requestHeaders,
      });
    } catch (error) {
      return {
        error: publicAuthErrorMessage(
          error,
          "Could not grant this member access to the repository.",
        ),
      };
    }
    await recordAudit({
      orgId: project.orgId,
      actorUserId: auth.user.id,
      action: "member_granted_repo",
      target: email,
      meta: { projectId: project.id, teamId },
    });
    return { ok: true as const };
  }

  try {
    const pending = await findPendingInvitation(
      project.orgId,
      email,
      auth.requestHeaders,
    );
    if (pending && !invitationTargetsTeam(pending.teamId, teamId)) {
      // A pending invitation for OTHER repos: resend:true would re-send it unchanged and drop
      // this repo, so replace it with one carrying the merged team list. Keep its role — the
      // dialog only mints `member` invitations, but never downgrade an unexpected one.
      await betterAuth.api.cancelInvitation({
        body: { invitationId: pending.id },
        headers: auth.requestHeaders,
      });
      await betterAuth.api.createInvitation({
        body: {
          email,
          role: (pending.role ?? "member") as "member",
          organizationId: project.orgId,
          teamId: [...splitInvitationTeamIds(pending.teamId), teamId],
        },
        headers: auth.requestHeaders,
      });
    } else {
      // New email, or a lapsed/duplicate invite already targeting this repo — resend:true
      // refreshes + re-sends instead of erroring (org.members resend-invite precedent; the
      // dialog has no separate resend control). Invitees join with the member role — front
      // of house only, scoped to this repo's team.
      await betterAuth.api.createInvitation({
        body: {
          email,
          role: "member",
          organizationId: project.orgId,
          teamId,
          resend: true,
        },
        headers: auth.requestHeaders,
      });
    }
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

/** This email's pending invitation in the org, if any (Better Auth allows at most one). */
async function findPendingInvitation(
  orgId: string,
  email: string,
  headers: Headers,
) {
  const invitations = await betterAuth.api.listInvitations({
    query: { organizationId: orgId },
    headers,
  });
  return (
    invitations.find(
      (candidate) =>
        candidate.status === "pending" &&
        candidate.email.toLowerCase() === email,
    ) ?? null
  );
}
