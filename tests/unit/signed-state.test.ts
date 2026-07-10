/**
 * Generic signed-state helper (issue #30) — the extracted HMAC round-trip the Google connection
 * broker signs OAuth state with. Must fail closed on tamper/expiry/wrong-key and never throw on
 * malformed input. `safeReturnTo` guards against open-redirects.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { safeReturnTo, signState, verifyState } from "~/lib/signed-state.server";

describe("signState / verifyState", () => {
  const key = randomBytes(32);
  const payload = { a: "one", b: 2, exp: 1_800_000_000_000 };

  it("round-trips a signed payload", () => {
    const token = signState(payload, key);
    expect(verifyState(token, key, payload.exp - 1000)).toEqual(payload);
  });

  it("rejects a tampered payload and a garbage signature", () => {
    const token = signState(payload, key);
    const [encoded, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...payload, a: "two" }), "utf8").toString(
      "base64url",
    );
    expect(verifyState(`${forged}.${sig}`, key, payload.exp - 1000)).toBeNull();
    expect(verifyState(`${encoded}.AAAA`, key, payload.exp - 1000)).toBeNull();
  });

  it("rejects the wrong key", () => {
    const token = signState(payload, key);
    expect(verifyState(token, randomBytes(32), payload.exp - 1000)).toBeNull();
  });

  it("rejects an expired payload (numeric exp)", () => {
    const token = signState(payload, key);
    expect(verifyState(token, key, payload.exp)).toBeNull();
    expect(verifyState(token, key, payload.exp + 1)).toBeNull();
  });

  it("accepts a payload with no exp (never expires)", () => {
    const token = signState({ hello: "world" }, key);
    expect(verifyState(token, key)).toEqual({ hello: "world" });
  });

  it("returns null on malformed input without throwing", () => {
    expect(verifyState("", key)).toBeNull();
    expect(verifyState("no-dot", key)).toBeNull();
    expect(verifyState("a.b.c", key)).toBeNull();
  });
});

describe("safeReturnTo", () => {
  it("accepts a same-origin relative path", () => {
    expect(safeReturnTo("/marketplace/bundle/x/install?project=p")).toBe(
      "/marketplace/bundle/x/install?project=p",
    );
    expect(safeReturnTo("/dashboard")).toBe("/dashboard");
  });

  it("rejects absolute, protocol-relative, and backslash paths", () => {
    expect(safeReturnTo("https://evil.example/x")).toBeNull();
    expect(safeReturnTo("//evil.example")).toBeNull();
    expect(safeReturnTo("/\\evil.example")).toBeNull();
    expect(safeReturnTo("/a\\b")).toBeNull();
    expect(safeReturnTo("relative")).toBeNull();
    expect(safeReturnTo("")).toBeNull();
    expect(safeReturnTo(null)).toBeNull();
    expect(safeReturnTo(undefined)).toBeNull();
  });
});
