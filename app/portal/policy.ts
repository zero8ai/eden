/**
 * Pure decision rules for Agent Portals (issue #180). Kept free of DB/framework imports so the
 * guest-facing gates — who gets an OTP email, which turns the stream action accepts — are
 * unit-testable exactly as enforced.
 */

/**
 * Whether a sign-in OTP email should be sent at all. Enforced INSIDE the Better Auth plugin's
 * send callback, so even direct calls to the generic /api/auth/email-otp endpoints cannot spam
 * arbitrary mailboxes or mint guest accounts for ungranted emails (no OTP ever leaves, so
 * verification can never succeed). Skipping silently keeps the response uniform — no email
 * enumeration.
 */
export function shouldSendPortalOtp(input: {
  type: "sign-in" | "email-verification" | "forget-password" | "change-email";
  hasLiveGrant: boolean;
}): boolean {
  // Portals only use sign-in OTPs; nothing else in Eden sends email OTPs today.
  return input.type === "sign-in" && input.hasLiveGrant;
}

/**
 * Whether a portal magic-link email should be sent. Same guarantee as {@link shouldSendPortalOtp}:
 * enforced INSIDE the Better Auth send callback, so direct calls to /api/auth/sign-in/magic-link
 * cannot mail sign-in links to — or mint guest accounts for — emails with no live grant. Magic
 * links are the primary portal sign-in; the OTP code stays as a fallback for clients whose mail
 * scanners pre-consume links.
 */
export function shouldSendPortalMagicLink(input: {
  hasLiveGrant: boolean;
}): boolean {
  return input.hasLiveGrant;
}

export type PortalTurnDecision =
  | { allowed: true }
  | { allowed: false; status: number; error: string };

/**
 * Abuse controls on the portal stream action: a per-guest rolling-hour rate limit and an
 * optional per-portal rolling-30-day cap. Both count accepted turns (portal_turns rows) —
 * non-members can invoke the model, so the door is narrower than the members-only playground.
 */
export function evaluatePortalTurn(input: {
  guestTurnsLastHour: number;
  turnsPerHour: number;
  portalTurnsLast30d: number;
  monthlyTurnCap: number | null;
}): PortalTurnDecision {
  if (input.guestTurnsLastHour >= input.turnsPerHour) {
    return {
      allowed: false,
      status: 429,
      error:
        "You've reached this portal's hourly message limit. Please try again later.",
    };
  }
  if (
    input.monthlyTurnCap !== null &&
    input.portalTurnsLast30d >= input.monthlyTurnCap
  ) {
    return {
      allowed: false,
      status: 429,
      error:
        "This portal has reached its monthly usage cap. Contact the team that runs it.",
    };
  }
  return { allowed: true };
}
