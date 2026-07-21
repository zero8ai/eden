import { describe, expect, it } from "vitest";

import {
  evaluatePortalTurn,
  shouldSendPortalMagicLink,
  shouldSendPortalOtp,
} from "~/portal/policy";

describe("shouldSendPortalMagicLink", () => {
  it("sends a magic link only when a live grant exists", () => {
    expect(shouldSendPortalMagicLink({ hasLiveGrant: true })).toBe(true);
    expect(shouldSendPortalMagicLink({ hasLiveGrant: false })).toBe(false);
  });
});

describe("shouldSendPortalOtp", () => {
  it("sends a sign-in OTP only when a live grant exists", () => {
    expect(shouldSendPortalOtp({ type: "sign-in", hasLiveGrant: true })).toBe(
      true,
    );
    expect(shouldSendPortalOtp({ type: "sign-in", hasLiveGrant: false })).toBe(
      false,
    );
  });

  it("never sends non-sign-in OTP types (portals only use sign-in)", () => {
    for (const type of [
      "email-verification",
      "forget-password",
      "change-email",
    ] as const) {
      expect(shouldSendPortalOtp({ type, hasLiveGrant: true })).toBe(false);
    }
  });
});

describe("evaluatePortalTurn", () => {
  const base = {
    guestTurnsLastHour: 0,
    turnsPerHour: 20,
    portalTurnsLast30d: 0,
    monthlyTurnCap: null,
  };

  it("allows a turn under all limits", () => {
    expect(evaluatePortalTurn(base)).toEqual({ allowed: true });
  });

  it("rejects with 429 when the guest hits the hourly rate limit", () => {
    const decision = evaluatePortalTurn({ ...base, guestTurnsLastHour: 20 });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.status).toBe(429);
  });

  it("rejects with 429 when the portal hits its monthly cap", () => {
    const decision = evaluatePortalTurn({
      ...base,
      portalTurnsLast30d: 500,
      monthlyTurnCap: 500,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.status).toBe(429);
  });

  it("treats a null monthly cap as uncapped", () => {
    expect(
      evaluatePortalTurn({ ...base, portalTurnsLast30d: 1_000_000 }),
    ).toEqual({ allowed: true });
  });

  it("the hourly limit wins over the monthly cap in the error message", () => {
    const decision = evaluatePortalTurn({
      ...base,
      guestTurnsLastHour: 20,
      portalTurnsLast30d: 500,
      monthlyTurnCap: 500,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.error).toMatch(/hourly/i);
  });
});
