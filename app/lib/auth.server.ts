import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { emailOTP, organization } from "better-auth/plugins";

import { db } from "~/db/client.server";
import * as schema from "~/db/auth-schema";
import { sendOrganizationInvitation } from "~/email/send-organization-invitation.server";
import { sendEmailVerification } from "~/email/send-email-verification.server";
import { sendPasswordResetEmail } from "~/email/send-password-reset.server";
import { sendPortalOtpEmail } from "~/email/send-portal-otp.server";
import { assertProductionAuthEnvironment } from "~/lib/auth-env.server";
import { shouldSendPortalOtp } from "~/portal/policy";
import { findLivePortalForEmail } from "~/portal/portals.server";

assertProductionAuthEnvironment();

export const auth = betterAuth({
  appName: "Eden",
  // Production request paths can carry one-time tokens. Better Auth's default error logger may
  // serialize endpoint params (its `args` can include token-bearing bodies), so production logs
  // the message line only — enough to observe provider failures (e.g. a swallowed invitation
  // email rejection) without ever serializing an error object or endpoint input. Development
  // keeps the framework's full diagnostics.
  logger:
    process.env.NODE_ENV === "production"
      ? {
          level: "error" as const,
          log: (level: string, message: string) => {
            console.error(`[better-auth:${level}] ${message}`);
          },
        }
      : undefined,
  onAPIError:
    process.env.NODE_ENV === "production" ? { throw: true } : undefined,
  database: drizzleAdapter(db, { provider: "pg", schema }),
  // Long-lived sessions (issue #180): portal guests sign in with a one-time code and have no
  // password to re-enter, so a short session would mean constant OTP round-trips. 30 days,
  // rolling — applies to all users (Better Auth sessions are not per-plugin).
  session: {
    expiresIn: 60 * 60 * 24 * 30,
  },
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
      // Await so a provider rejection fails the endpoint: the invite-verification gate is
      // hard-blocked on this email, and a silent 200 would strand the invitee behind a
      // "verification sent" message that never arrives.
      try {
        await sendEmailVerification({
          userEmail: user.email,
          verificationUrl: url,
        });
      } catch (error) {
        // Provider errors can include the token-bearing HTML body; log the error name only.
        console.error(
          `Could not send an email verification message (${(error as Error)?.name ?? "Error"}).`,
        );
        throw new APIError("INTERNAL_SERVER_ERROR", {
          message: "Could not send the verification email.",
        });
      }
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
      // Deliberately fire-and-forget: /forgot-password must answer uniformly whether or not an
      // account exists (anti-enumeration), so a provider failure can't change the response. The
      // sanitized marker below keeps the failure observable in production logs.
      void sendPasswordResetEmail({
        userEmail: user.email,
        resetUrl: url,
      }).catch((error) => {
        // Do not log the error object: provider errors can include the token-bearing HTML body.
        console.error(
          `Could not send a password reset email (${(error as Error)?.name ?? "Error"}).`,
        );
      });
    },
  },
  plugins: [
    // Agent Portals guest sign-in (issue #180): a 6-digit emailed code, no password, no org.
    // The grant check lives INSIDE this send callback, so even direct calls to the generic
    // /api/auth/email-otp endpoints can't spam arbitrary mailboxes or mint guest users for
    // ungranted emails — no code ever leaves, so verification can never succeed. Skipping is
    // silent on purpose: the endpoint answers uniformly (anti-enumeration).
    emailOTP({
      otpLength: 6,
      expiresIn: 10 * 60,
      allowedAttempts: 3,
      async sendVerificationOTP({ email, otp, type }) {
        const portal = await findLivePortalForEmail(email);
        if (!shouldSendPortalOtp({ type, hasLiveGrant: portal !== null })) {
          return;
        }
        try {
          await sendPortalOtpEmail({
            userEmail: email,
            portalName: portal!.portalName,
            otp,
          });
        } catch (error) {
          // Never log the error object: provider errors can include the code-bearing HTML body.
          console.error(
            `Could not send a portal sign-in code (${(error as Error)?.name ?? "Error"}).`,
          );
          throw new APIError("INTERNAL_SERVER_ERROR", {
            message: "Could not send the sign-in code.",
          });
        }
      },
    }),
    organization({
      // Better Auth ships POST /api/auth/organization/delete enabled by default; Eden's tables
      // cascade from organization.id, so one owner-session call would erase an entire tenant
      // (projects, deployments, secrets — and the audit log recording it) while leaving deployed
      // containers orphaned. No Eden flow calls it; keep it off until an app-owned teardown
      // exists.
      disableOrganizationDeletion: true,
      // CVE-2026-53514: invitation IDs can be listed by organization members. Require the
      // recipient to prove mailbox ownership before get/accept/reject invitation operations.
      requireEmailVerificationOnInvitation: true,
      sendInvitationEmail: async (invitation) => {
        // Better Auth awaits this but swallows a rejection into logger.error, so log a sanitized
        // marker ourselves (never the error object — provider errors can include the
        // token-bearing HTML body) before rethrowing for the framework logger.
        try {
          await sendOrganizationInvitation(invitation);
        } catch (error) {
          console.error(
            `Could not send an organization invitation email (${(error as Error)?.name ?? "Error"}).`,
          );
          throw error;
        }
      },
    }),
  ],
});
