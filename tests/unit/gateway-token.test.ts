/**
 * Model-gateway tokens (issue #28) — mint/verify round-trip, tamper rejection, and prefix
 * isolation from the assistant token (an `edna_` token must NEVER verify as a gateway token).
 * Pure over an injected key, so no env is needed.
 */
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";

import { mintGatewayToken, verifyGatewayToken } from "~/gateway/token.server";
import { mintAssistantToken } from "~/assistant/token.server";

const KEY = crypto.randomBytes(32);

describe("gateway token mint/verify", () => {
  it("round-trips an org id", () => {
    const token = mintGatewayToken("org_abc", KEY);
    expect(token.startsWith("edng_")).toBe(true);
    expect(verifyGatewayToken(token, KEY)).toBe("org_abc");
  });

  it("rejects a tampered signature", () => {
    const token = mintGatewayToken("org_abc", KEY);
    const tampered = token.slice(0, -2) + (token.endsWith("aa") ? "bb" : "aa");
    expect(verifyGatewayToken(tampered, KEY)).toBeNull();
  });

  it("rejects a tampered org id (signature no longer matches)", () => {
    const token = mintGatewayToken("org_abc", KEY);
    const forged = token.replace("org_abc", "org_evil");
    expect(verifyGatewayToken(forged, KEY)).toBeNull();
  });

  it("rejects a token signed with a different key", () => {
    const token = mintGatewayToken("org_abc", KEY);
    expect(verifyGatewayToken(token, crypto.randomBytes(32))).toBeNull();
  });

  it("rejects the wrong prefix — an assistant token must not verify as a gateway token", () => {
    // The assistant token uses the same key source but a distinct `edna_` prefix; a gateway
    // verify must never accept it (and vice-versa), so a leaked token can't cross surfaces.
    const assistant = mintAssistantToken("dep_1", KEY);
    expect(assistant.startsWith("edng_")).toBe(false);
    expect(verifyGatewayToken(assistant, KEY)).toBeNull();
  });

  it("rejects garbage", () => {
    expect(verifyGatewayToken("", KEY)).toBeNull();
    expect(verifyGatewayToken("edng_", KEY)).toBeNull();
    expect(verifyGatewayToken("edng_noSignature", KEY)).toBeNull();
  });
});
