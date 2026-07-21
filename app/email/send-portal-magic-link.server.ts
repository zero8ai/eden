import { sendEmail } from "~/lib/email-client.server";
import { renderPortalMagicLinkEmail } from "./templates/portal-magic-link";

/**
 * Deliver a portal guest's one-click sign-in link (issue #180). Called from the Better Auth
 * magicLink `sendMagicLink` callback, which has already gated on a live grant, so this never
 * mails a link to an ungranted address.
 */
export async function sendPortalMagicLinkEmail(input: {
  userEmail: string;
  portalName: string;
  url: string;
}): Promise<void> {
  const html = await renderPortalMagicLinkEmail({
    portalName: input.portalName,
    url: input.url,
  });
  await sendEmail({
    to: input.userEmail,
    subject: `Your sign-in link for ${input.portalName}`,
    html,
  });
}
