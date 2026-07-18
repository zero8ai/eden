import { sendEmail } from "~/lib/email-client.server";
import { renderPortalInviteEmail } from "./templates/portal-invite";

function appUrl(): string {
  const value = process.env.BETTER_AUTH_URL?.trim();
  if (!value)
    throw new Error("BETTER_AUTH_URL is required to send portal invitations.");
  return value;
}

export async function sendPortalInvite(input: {
  email: string;
  portalName: string;
  portalSlug: string;
  inviterName: string;
}): Promise<void> {
  const portalUrl = new URL(
    `/a/${encodeURIComponent(input.portalSlug)}`,
    appUrl(),
  ).toString();
  const html = await renderPortalInviteEmail({
    portalName: input.portalName,
    portalUrl,
    inviterName: input.inviterName,
  });
  await sendEmail({
    to: input.email,
    subject: `You have access to ${input.portalName} on Eden`,
    html,
  });
}
