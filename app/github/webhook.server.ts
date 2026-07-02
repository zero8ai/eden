/**
 * GitHub webhook signature verification (Connect/Deploy pillars).
 * Validates the `x-hub-signature-256` HMAC so only GitHub can trigger merge→deploy.
 */
import crypto from "node:crypto";

/** Constant-time verify of a GitHub `sha256=` signature over the raw request body. */
export function verifyGitHubSignature(rawBody: string, signature: string | null): boolean {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret || !signature) return false;
  const expected =
    "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
