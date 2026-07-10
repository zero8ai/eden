/**
 * Generic HMAC-signed, expiring state token for OAuth-style redirect round-trips.
 *
 * A caller signs a JSON payload with a key; the provider bounces it back on the redirect; the
 * caller verifies it (signature + expiry) before trusting a single field. This is the pattern
 * the Discord connect flow (app/discord/connect.server.ts) and the GitHub manifest flow each
 * grew their own copy of; the Google connection broker (issue #30) extracts it here so the new
 * flow shares one audited implementation. Discord/GitHub keep their bespoke copies untouched.
 *
 * Shape: `base64url(JSON payload) . base64url(HMAC-SHA256(payload))`. Verification is constant-time
 * on the signature and never throws on malformed input — it returns null, so a forged or truncated
 * token is indistinguishable from an expired one to the caller.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const b64url = (buf: Buffer) => buf.toString("base64url");

function signature(payload: string, key: Buffer): Buffer {
  return createHmac("sha256", key).update(payload).digest();
}

/** Sign an arbitrary JSON-serializable payload → a tamper-evident, self-describing token. */
export function signState<T>(payload: T, key: Buffer): string {
  const encoded = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  return `${encoded}.${b64url(signature(encoded, key))}`;
}

/**
 * Verify a token's signature and (if the payload carries a numeric `exp` in unix ms) its expiry.
 * Returns the parsed payload, or null on any problem — bad shape, wrong key, tamper, expiry.
 * The caller is responsible for field-level validation of the returned object.
 */
export function verifyState<T = unknown>(
  token: string,
  key: Buffer,
  now: number = Date.now(),
): T | null {
  if (typeof token !== "string") return null;
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const encoded = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let given: Buffer;
  try {
    given = Buffer.from(sig, "base64url");
  } catch {
    return null;
  }
  const expected = signature(encoded, key);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { exp?: unknown }).exp === "number" &&
      (parsed as { exp: number }).exp <= now
    ) {
      return null;
    }
    return parsed as T;
  } catch {
    return null;
  }
}

/**
 * A same-origin relative path guard for OAuth `returnTo` values. Only a path that starts with a
 * single "/" (not "//", not "/\") is safe to redirect to after the round-trip — anything else is a
 * potential open-redirect vector. Returns the path when safe, else null.
 */
export function safeReturnTo(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (!value.startsWith("/")) return null;
  if (value.startsWith("//")) return null;
  if (value.startsWith("/\\")) return null;
  if (value.includes("\\")) return null;
  return value;
}
