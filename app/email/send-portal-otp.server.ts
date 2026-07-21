import { sendEmail } from "~/lib/email-client.server";
import { renderPortalOtpEmail } from "./templates/portal-otp";

export async function sendPortalOtpEmail(input: {
  userEmail: string;
  portalName: string;
  otp: string;
}): Promise<void> {
  const html = await renderPortalOtpEmail({
    portalName: input.portalName,
    otp: input.otp,
  });
  await sendEmail({
    to: input.userEmail,
    subject: `${input.otp} is your ${input.portalName} sign-in code`,
    html,
  });
}
