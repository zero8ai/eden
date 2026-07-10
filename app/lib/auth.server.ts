import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";

import { db } from "~/db/client.server";
import * as schema from "~/db/auth-schema";
import { sendOrganizationInvitation } from "~/email/send-organization-invitation.server";
import { sendPasswordResetEmail } from "~/email/send-password-reset.server";

export const auth = betterAuth({
  appName: "Eden",
  database: drizzleAdapter(db, { provider: "pg", schema }),
  advanced: {
    // The supported production topology puts Eden directly behind nginx, which overwrites
    // X-Real-IP with the TCP peer address. Reading that single trusted value keeps Better Auth's
    // production rate limits per-client without accepting a spoofable forwarded chain.
    ipAddress: { ipAddressHeaders: ["x-real-ip"] },
  },
  emailAndPassword: {
    enabled: true,
    autoSignIn: true,
    requireEmailVerification: false,
    minPasswordLength: 8,
    maxPasswordLength: 128,
    resetPasswordTokenExpiresIn: 60 * 60,
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ user, url }) => {
      void sendPasswordResetEmail({
        userEmail: user.email,
        resetUrl: url,
      }).catch(() => {
        // Do not log the error object: provider errors can include the token-bearing HTML body.
        console.error("Could not send a password reset email.");
      });
    },
  },
  plugins: [
    organization({
      sendInvitationEmail: sendOrganizationInvitation,
    }),
  ],
});
