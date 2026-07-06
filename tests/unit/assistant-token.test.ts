import crypto from "node:crypto";
import { describe, expect, it } from "vitest";

import { mintAssistantToken, verifyAssistantToken } from "~/assistant/token.server";
import { mintDelegationToken } from "~/team/token.server";

const key = crypto.randomBytes(32);

describe("assistant token", () => {
  it("round-trips a deployment id", () => {
    const token = mintAssistantToken("dep_123", key);
    expect(token.startsWith("edna_")).toBe(true);
    expect(verifyAssistantToken(token, key)).toBe("dep_123");
  });

  it("rejects tamper, wrong key, and malformed tokens", () => {
    const token = mintAssistantToken("dep_123", key);
    expect(verifyAssistantToken(token + "x", key)).toBeNull();
    expect(verifyAssistantToken(token, crypto.randomBytes(32))).toBeNull();
    expect(verifyAssistantToken("edna_dep_123.", key)).toBeNull();
    expect(verifyAssistantToken("nope", key)).toBeNull();
  });

  it("is NOT interchangeable with a team-delegation token", () => {
    // Same key, same deployment id, different prefix — neither verifier accepts the other.
    const team = mintDelegationToken("dep_123", key);
    expect(team.startsWith("ednt_")).toBe(true);
    expect(verifyAssistantToken(team, key)).toBeNull();
  });
});
