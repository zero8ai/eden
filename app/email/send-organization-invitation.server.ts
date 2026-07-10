import { sendEmail } from "~/lib/email-client.server";
import { renderOrganizationInvitationEmail } from "./templates/organization-invitation";

type InvitationEmail = {
  id: string;
  email: string;
  organization: { name: string };
  inviter: { user: { name: string; email: string } };
};

function appUrl(): string {
  const value = process.env.BETTER_AUTH_URL?.trim();
  if (!value)
    throw new Error("BETTER_AUTH_URL is required to send invitations.");
  return value;
}

export async function sendOrganizationInvitation(
  data: InvitationEmail,
): Promise<void> {
  const invitationUrl = new URL(
    `/accept-invitation/${encodeURIComponent(data.id)}`,
    appUrl(),
  ).toString();
  const inviterName = data.inviter.user.name || data.inviter.user.email;
  const html = await renderOrganizationInvitationEmail({
    invitationUrl,
    inviterEmail: data.inviter.user.email,
    inviterName,
    organizationName: data.organization.name,
  });

  await sendEmail({
    to: data.email,
    subject: `Join ${data.organization.name} on Eden`,
    html,
  });
}
