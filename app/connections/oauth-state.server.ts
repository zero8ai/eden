import { createHash, randomBytes } from "node:crypto";

import { and, eq, gt, lt } from "drizzle-orm";

import { db } from "~/db/client.server";
import { connectionOauthStates } from "~/db/schema";

function nonceHash(nonce: string): string {
  return createHash("sha256").update(nonce).digest("hex");
}

export async function createOAuthStateNonce(input: {
  userId: string;
  sessionId: string;
  expiresAt: Date;
}): Promise<string> {
  const now = new Date();
  await db
    .delete(connectionOauthStates)
    .where(lt(connectionOauthStates.expiresAt, now));

  const nonce = randomBytes(32).toString("base64url");
  await db.insert(connectionOauthStates).values({
    nonceHash: nonceHash(nonce),
    userId: input.userId,
    sessionId: input.sessionId,
    expiresAt: input.expiresAt,
  });
  return nonce;
}

/** Atomically consume a live nonce bound to the initiating Better Auth user and session. */
export async function consumeOAuthStateNonce(input: {
  nonce: string;
  userId: string;
  sessionId: string;
}): Promise<boolean> {
  const deleted = await db
    .delete(connectionOauthStates)
    .where(
      and(
        eq(connectionOauthStates.nonceHash, nonceHash(input.nonce)),
        eq(connectionOauthStates.userId, input.userId),
        eq(connectionOauthStates.sessionId, input.sessionId),
        gt(connectionOauthStates.expiresAt, new Date()),
      ),
    )
    .returning({ nonceHash: connectionOauthStates.nonceHash });
  return deleted.length === 1;
}
