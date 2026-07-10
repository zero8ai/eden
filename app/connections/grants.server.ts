/**
 * Persisted connection grants (issue #30). A row holds an app-scoped OAuth grant for one
 * (project, agent, provider): the sealed refresh token plus display metadata (account email,
 * scopes, status). Written by the connect callback, read by the install wizard / Deployment tab
 * (metadata only) and by deploy (which alone unseals the token). Direct-Drizzle, upsert-on-
 * conflict — mirrors app/discord/connections.server.ts.
 *
 * The refresh token is sealed with the same AES-256-GCM secretbox as `secret_values`. Loader-
 * facing functions NEVER return the plaintext; only `openRefreshToken` unseals, and only
 * deploy-side code calls it.
 */
import { and, desc, eq, isNull } from "drizzle-orm";

import { db } from "~/db/client.server";
import { connectionGrants } from "~/db/schema";
import { decodeKey, open, seal } from "~/seams/oss/secretbox";

export type GrantStatus = "active" | "expired" | "revoked";

/** Display-safe grant: everything but the sealed token. Safe to return to loaders. */
export interface ConnectionGrant {
  id: string;
  projectId: string;
  agentId: string;
  environmentId: string | null;
  provider: string;
  accountEmail: string | null;
  scopes: string;
  status: GrantStatus;
}

export interface UpsertGrantInput {
  projectId: string;
  agentId: string;
  /** null = all environments (always null in Phase 1). */
  environmentId?: string | null;
  provider: string;
  accountEmail: string | null;
  scopes: string;
  refreshToken: string;
  createdBy?: string | null;
}

function secretsKey(): Buffer {
  return decodeKey(process.env.EDEN_SECRETS_KEY);
}

function toGrant(row: typeof connectionGrants.$inferSelect): ConnectionGrant {
  return {
    id: row.id,
    projectId: row.projectId,
    agentId: row.agentId,
    environmentId: row.environmentId,
    provider: row.provider,
    accountEmail: row.accountEmail,
    scopes: row.scopes,
    status: row.status as GrantStatus,
  };
}

/**
 * Create or refresh the grant for (project, agent, provider). Seals the refresh token and, on
 * conflict, re-activates the row (a reconnect flips an expired/revoked grant back to "active" and
 * replaces the token + metadata). Returns the display-safe grant.
 */
export async function upsertGrant(input: UpsertGrantInput): Promise<ConnectionGrant> {
  const sealed = seal(secretsKey(), input.refreshToken);
  const environmentId = input.environmentId ?? null;
  const [row] = await db
    .insert(connectionGrants)
    .values({
      projectId: input.projectId,
      agentId: input.agentId,
      environmentId,
      provider: input.provider,
      accountEmail: input.accountEmail,
      scopes: input.scopes,
      status: "active",
      refreshTokenCiphertext: sealed.ciphertext,
      refreshTokenIv: sealed.iv,
      refreshTokenAuthTag: sealed.authTag,
      createdBy: input.createdBy ?? null,
    })
    .onConflictDoUpdate({
      target: [
        connectionGrants.projectId,
        connectionGrants.agentId,
        connectionGrants.environmentId,
        connectionGrants.provider,
      ],
      set: {
        accountEmail: input.accountEmail,
        scopes: input.scopes,
        status: "active",
        refreshTokenCiphertext: sealed.ciphertext,
        refreshTokenIv: sealed.iv,
        refreshTokenAuthTag: sealed.authTag,
        updatedAt: new Date(),
      },
    })
    .returning();
  return toGrant(row);
}

/** The grant for (project, agent, provider) with a null environment (Phase 1 scope). */
export async function findGrant(input: {
  projectId: string;
  agentId: string;
  provider: string;
}): Promise<ConnectionGrant | null> {
  const [row] = await db
    .select()
    .from(connectionGrants)
    .where(
      and(
        eq(connectionGrants.projectId, input.projectId),
        eq(connectionGrants.agentId, input.agentId),
        eq(connectionGrants.provider, input.provider),
        isNull(connectionGrants.environmentId),
      ),
    )
    .limit(1);
  return row ? toGrant(row) : null;
}

/** Every grant for an agent (the Deployment tab's Connections card lists these). */
export async function listGrantsForAgent(
  agentId: string,
): Promise<ConnectionGrant[]> {
  const rows = await db
    .select()
    .from(connectionGrants)
    .where(eq(connectionGrants.agentId, agentId))
    .orderBy(desc(connectionGrants.createdAt));
  return rows.map(toGrant);
}

/** Flip a grant's status (e.g. deploy found the token dead → "expired"). */
export async function markGrantStatus(
  id: string,
  status: GrantStatus,
): Promise<void> {
  await db
    .update(connectionGrants)
    .set({ status, updatedAt: new Date() })
    .where(eq(connectionGrants.id, id));
}

/**
 * Unseal a grant's refresh token. DEPLOY-SIDE ONLY — never call from a loader that renders to a
 * client. Takes the full row (via a fresh lookup) so the plaintext never rides on the display type.
 */
export async function openRefreshToken(input: {
  projectId: string;
  agentId: string;
  provider: string;
}): Promise<{ grant: ConnectionGrant; refreshToken: string } | null> {
  const [row] = await db
    .select()
    .from(connectionGrants)
    .where(
      and(
        eq(connectionGrants.projectId, input.projectId),
        eq(connectionGrants.agentId, input.agentId),
        eq(connectionGrants.provider, input.provider),
        isNull(connectionGrants.environmentId),
      ),
    )
    .limit(1);
  if (!row) return null;
  const refreshToken = open(secretsKey(), {
    ciphertext: row.refreshTokenCiphertext,
    iv: row.refreshTokenIv,
    authTag: row.refreshTokenAuthTag,
  });
  return { grant: toGrant(row), refreshToken };
}
