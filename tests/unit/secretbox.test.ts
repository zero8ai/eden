import crypto from "node:crypto";
import { describe, expect, it } from "vitest";

import { decodeKey, open, seal } from "~/seams/oss/secretbox";

const key = crypto.randomBytes(32);

describe("secretbox seal/open", () => {
  it("round-trips a value", () => {
    const sealed = seal(key, "sk-super-secret");
    expect(sealed.ciphertext).not.toContain("sk-super-secret");
    expect(open(key, sealed)).toBe("sk-super-secret");
  });

  it("produces a fresh IV per seal (no deterministic ciphertext reuse)", () => {
    const a = seal(key, "same");
    const b = seal(key, "same");
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("fails to open under a different key or tampered ciphertext", () => {
    const sealed = seal(key, "value");
    expect(() => open(crypto.randomBytes(32), sealed)).toThrow();
    expect(() => open(key, { ...sealed, ciphertext: Buffer.from("garbage").toString("base64") })).toThrow();
  });
});

describe("decodeKey", () => {
  it("accepts 64 hex chars and 32-byte base64", () => {
    expect(decodeKey("a".repeat(64)).length).toBe(32);
    expect(decodeKey(crypto.randomBytes(32).toString("base64")).length).toBe(32);
  });

  it("rejects a missing or wrong-length key", () => {
    expect(() => decodeKey(undefined)).toThrow(/not set/);
    expect(() => decodeKey("tooshort")).toThrow(/32 bytes/);
  });
});
