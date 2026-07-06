/**
 * Delegation token sign/verify (Team delegation — D3). Pins the round-trip, tamper rejection,
 * wrong-key rejection, and malformed-token handling — all against an injected key (no env).
 */
import crypto from "node:crypto";

import { describe, expect, it } from "vitest";

import { mintDelegationToken, verifyDelegationToken } from "~/team/token.server";

const KEY = crypto.randomBytes(32);
const OTHER_KEY = crypto.randomBytes(32);

describe("delegation token", () => {
  it("round-trips a deployment id", () => {
    const token = mintDelegationToken("dep_abc123", KEY);
    expect(token.startsWith("ednt_")).toBe(true);
    expect(verifyDelegationToken(token, KEY)).toBe("dep_abc123");
  });

  it("rejects a token signed with a different key", () => {
    const token = mintDelegationToken("dep_abc123", OTHER_KEY);
    expect(verifyDelegationToken(token, KEY)).toBeNull();
  });

  it("rejects a tampered deployment id (signature no longer matches)", () => {
    const token = mintDelegationToken("dep_abc123", KEY);
    const forged = token.replace("dep_abc123", "dep_victim");
    expect(verifyDelegationToken(forged, KEY)).toBeNull();
  });

  it("rejects a tampered signature", () => {
    const token = mintDelegationToken("dep_abc123", KEY);
    const bad = `${token.slice(0, -2)}xy`;
    expect(verifyDelegationToken(bad, KEY)).toBeNull();
  });

  it("rejects malformed tokens", () => {
    expect(verifyDelegationToken("", KEY)).toBeNull();
    expect(verifyDelegationToken("nope", KEY)).toBeNull();
    expect(verifyDelegationToken("ednt_", KEY)).toBeNull();
    expect(verifyDelegationToken("ednt_dep_abc123", KEY)).toBeNull(); // no signature
  });
});
