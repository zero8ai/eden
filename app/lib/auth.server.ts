import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";

import { db } from "~/db/client.server";
import * as schema from "~/db/auth-schema";
import { sendOrganizationInvitation } from "~/email/send-organization-invitation.server";
import { sendEmailVerification } from "~/email/send-email-verification.server";
import { sendPasswordResetEmail } from "~/email/send-password-reset.server";
import { assertProductionAuthEnvironment } from "~/lib/auth-env.server";

assertProductionAuthEnvironment();

export const auth = betterAuth({
  appName: "Eden",
  // Production request paths can carry one-time tokens. Better Auth's default error logger may
  // serialize endpoint params, so production returns errors to the route boundary without logging
  // internals. Development keeps the framework's diagnostics.
  logger:
    process.env.NODE_ENV === "production" ? { disabled: true } : undefined,
  onAPIError:
    process.env.NODE_ENV === "production" ? { throw: true } : undefined,
  database: drizzleAdapter(db, { provider: "pg", schema }),
  advanced: {
    // The supported production topology puts Eden directly behind nginx, which overwrites
    // X-Real-IP with the TCP peer address. Reading that single trusted value keeps Better Auth's
    // production rate limits per-client without accepting a spoofable forwarded chain.
    ipAddress: { ipAddressHeaders: ["x-real-ip"] },
  },
  emailVerification: {
    // Ordinary email/password signup and sign-in stay verification-free. Verification is sent
    // manually only when Better Auth's organization plugin requires mailbox proof for an invite.
    sendOnSignUp: false,
    sendOnSignIn: false,
    expiresIn: 60 * 60,
    sendVerificationEmail: async ({ user, url }) => {
      void sendEmailVerification({
        userEmail: user.email,
        verificationUrl: url,
      }).catch(() => {
        // Provider errors can include the token-bearing HTML body; never log the error object.
        console.error("Could not send an email verification message.");
      });
    },
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
      // CVE-2026-53514: invitation IDs can be listed by organization members. Require the
      // recipient to prove mailbox ownership before get/accept/reject invitation operations.
      requireEmailVerificationOnInvitation: true,
      sendInvitationEmail: sendOrganizationInvitation,
    }),
  ],
});
