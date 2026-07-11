/**
 * Model-provider connections accessor (issue #28, Phase 1) — the CRUD + credential seal/open
 * behind the "Model providers" list in Org settings and the model gateway.
 *
 * A row holds one connected provider account (Phase 1: a Codex ChatGPT subscription) for an org:
 * a label, the connected account's display email/id, and the AES-256-GCM sealed access + refresh
 * token triplets. Loader-facing functions (`listModelConnections`) return ONLY display metadata —
 * never a token; only the gateway path (`getConnectionForGateway` / `getFreshAccessToken`) unseals.
 *
 * Refresh is central: `getFreshAccessToken` refreshes when the access token is within 5 minutes of
 * expiry, single-flighted per connection (the control plane is one process, so an in-process
 * promise map collapses concurrent gateway requests onto one refresh) and always persists a rotated
 * refresh token. A dead grant marks the connection `expired` and throws `InvalidGrantError`.
 */
import { and, desc, eq } from "drizzle-orm";

import { db } from "~/db/client.server";
import { modelProviderConnections } from "~/db/schema";
import { decodeKey, open, seal } from "~/seams/oss/secretbox";
import {
  InvalidGrantError,
  refreshCodexTokens,
} from "~/connections/codex.server";

export type ConnectionStatus = "active" | "expired" | "revoked";

/** Display-safe connection — everything but the sealed tokens. Safe to return to loaders. */
export interface ModelConnection {
  id: string;
  provider: string;
  label: string;
  accountEmail: string | null;
  status: ConnectionStatus;
  createdAt: Date;
}

/** Gateway-side view including the unsealed tokens. NEVER return this to a loader/client. */
export interface GatewayConnection {
  id: string;
  orgId: string;
  provider: string;
  status: ConnectionStatus;
  accountId: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  accessTokenExpiresAt: Date | null;
}

function secretsKey(): Buffer {
  return decodeKey(process.env.EDEN_SECRETS_KEY);
}

function toDisplay(
  row: typeof modelProviderConnections.$inferSelect,
): ModelConnection {
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    accountEmail: row.accountEmail,
    status: row.status as ConnectionStatus,
    createdAt: row.createdAt,
  };
}

/** Create a Codex connection, sealing its access + refresh tokens. Returns the display row. */
export async function createCodexConnection(input: {
  orgId: string;
  label: string;
  accountEmail: string | null;
  accountId: string | null;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date | null;
  createdBy?: string | null;
}): Promise<ModelConnection> {
  const key = secretsKey();
  const access = seal(key, input.accessToken);
  const refresh = seal(key, input.refreshToken);
  const [row] = await db
    .insert(modelProviderConnections)
    .values({
      orgId: input.orgId,
      provider: "codex",
      label: input.label,
      accountEmail: input.accountEmail,
      accountId: input.accountId,
      accessTokenCiphertext: access.ciphertext,
      accessTokenIv: access.iv,
      accessTokenAuthTag: access.authTag,
      refreshTokenCiphertext: refresh.ciphertext,
      refreshTokenIv: refresh.iv,
      refreshTokenAuthTag: refresh.authTag,
      accessTokenExpiresAt: input.expiresAt,
      status: "active",
      createdBy: input.createdBy ?? null,
    })
    .returning();
  return toDisplay(row);
}

/** Every connection for an org, newest first — display metadata only. */
export async function listModelConnections(
  orgId: string,
): Promise<ModelConnection[]> {
  const rows = await db
    .select()
    .from(modelProviderConnections)
    .where(eq(modelProviderConnections.orgId, orgId))
    .orderBy(desc(modelProviderConnections.createdAt));
  return rows.map(toDisplay);
}

/** Active Codex connections for an org (drives the model-picker union + deploy injection). */
export async function listActiveCodexConnections(
  orgId: string,
): Promise<ModelConnection[]> {
  const rows = await db
    .select()
    .from(modelProviderConnections)
    .where(
      and(
        eq(modelProviderConnections.orgId, orgId),
        eq(modelProviderConnections.provider, "codex"),
        eq(modelProviderConnections.status, "active"),
      ),
    )
    .orderBy(desc(modelProviderConnections.createdAt));
  return rows.map(toDisplay);
}

/** Whether the org has at least one active Codex connection (deploy-injection gate). */
export async function hasActiveCodexConnection(orgId: string): Promise<boolean> {
  const rows = await listActiveCodexConnections(orgId);
  return rows.length > 0;
}

/** Rename a connection, org-checked (a mismatched org is a no-op). */
export async function renameModelConnection(
  orgId: string,
  id: string,
  label: string,
): Promise<void> {
  await db
    .update(modelProviderConnections)
    .set({ label, updatedAt: new Date() })
    .where(
      and(
        eq(modelProviderConnections.id, id),
        eq(modelProviderConnections.orgId, orgId),
      ),
    );
}

/** Delete a connection, org-checked. */
export async function deleteModelConnection(
  orgId: string,
  id: string,
): Promise<void> {
  await db
    .delete(modelProviderConnections)
    .where(
      and(
        eq(modelProviderConnections.id, id),
        eq(modelProviderConnections.orgId, orgId),
      ),
    );
}

/** Flip a connection's status (e.g. a dead refresh token → "expired"). */
export async function markConnectionStatus(
  id: string,
  status: ConnectionStatus,
): Promise<void> {
  await db
    .update(modelProviderConnections)
    .set({ status, updatedAt: new Date() })
    .where(eq(modelProviderConnections.id, id));
}

/** Load a connection with its tokens unsealed. Gateway/refresh-side only. */
export async function getConnectionForGateway(
  id: string,
): Promise<GatewayConnection | null> {
  const [row] = await db
    .select()
    .from(modelProviderConnections)
    .where(eq(modelProviderConnections.id, id))
    .limit(1);
  if (!row) return null;
  const key = secretsKey();
  const accessToken =
    row.accessTokenCiphertext && row.accessTokenIv && row.accessTokenAuthTag
      ? open(key, {
          ciphertext: row.accessTokenCiphertext,
          iv: row.accessTokenIv,
          authTag: row.accessTokenAuthTag,
        })
      : null;
  const refreshToken =
    row.refreshTokenCiphertext && row.refreshTokenIv && row.refreshTokenAuthTag
      ? open(key, {
          ciphertext: row.refreshTokenCiphertext,
          iv: row.refreshTokenIv,
          authTag: row.refreshTokenAuthTag,
        })
      : null;
  return {
    id: row.id,
    orgId: row.orgId,
    provider: row.provider,
    status: row.status as ConnectionStatus,
    accountId: row.accountId,
    accessToken,
    refreshToken,
    accessTokenExpiresAt: row.accessTokenExpiresAt,
  };
}

/** Persist tokens after a refresh, sealing both. Keeps status active. */
export async function persistRefreshedTokens(
  id: string,
  tokens: { accessToken: string; refreshToken: string; expiresAt: Date | null },
): Promise<void> {
  const key = secretsKey();
  const access = seal(key, tokens.accessToken);
  const refresh = seal(key, tokens.refreshToken);
  await db
    .update(modelProviderConnections)
    .set({
      accessTokenCiphertext: access.ciphertext,
      accessTokenIv: access.iv,
      accessTokenAuthTag: access.authTag,
      refreshTokenCiphertext: refresh.ciphertext,
      refreshTokenIv: refresh.iv,
      refreshTokenAuthTag: refresh.authTag,
      accessTokenExpiresAt: tokens.expiresAt,
      status: "active",
      updatedAt: new Date(),
    })
    .where(eq(modelProviderConnections.id, id));
}

/** Refresh when the access token is within this margin of expiry. */
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** A fresh access token + the account-id header value the gateway needs for a connection. */
export interface FreshAccess {
  accessToken: string;
  accountId: string | null;
}

// Single-flight: collapse concurrent refreshes of one connection onto a single upstream call.
const inflightRefresh = new Map<string, Promise<FreshAccess>>();

/**
 * Return a valid access token for a connection, refreshing (once, single-flighted) when it is
 * within REFRESH_MARGIN_MS of expiry or already expired. On `invalid_grant` the connection is
 * marked `expired` and `InvalidGrantError` is rethrown so the gateway can tell the user to
 * reconnect. `deps` is injected in tests to count refresh calls / avoid real I/O.
 */
export async function getFreshAccessToken(
  connectionId: string,
  deps: {
    load?: typeof getConnectionForGateway;
    refresh?: typeof refreshCodexTokens;
    persist?: typeof persistRefreshedTokens;
    markStatus?: typeof markConnectionStatus;
    now?: () => number;
  } = {},
): Promise<FreshAccess> {
  const load = deps.load ?? getConnectionForGateway;
  const refresh = deps.refresh ?? refreshCodexTokens;
  const persist = deps.persist ?? persistRefreshedTokens;
  const markStatus = deps.markStatus ?? markConnectionStatus;
  const now = deps.now ?? Date.now;

  const conn = await load(connectionId);
  if (!conn) throw new Error("Connection not found.");
  if (conn.status !== "active") {
    throw new InvalidGrantError(
      "This provider connection is no longer active — reconnect it in Org settings.",
    );
  }

  const expiresAt = conn.accessTokenExpiresAt?.getTime() ?? 0;
  const fresh =
    conn.accessToken != null && expiresAt - now() > REFRESH_MARGIN_MS;
  if (fresh && conn.accessToken) {
    return { accessToken: conn.accessToken, accountId: conn.accountId };
  }

  const existing = inflightRefresh.get(connectionId);
  if (existing) return existing;

  const run = (async (): Promise<FreshAccess> => {
    if (!conn.refreshToken) {
      await markStatus(connectionId, "expired");
      throw new InvalidGrantError(
        "This provider connection has no refresh token — reconnect it in Org settings.",
      );
    }
    try {
      const tokens = await refresh(conn.refreshToken);
      const expiry = new Date(now() + tokens.expiresIn * 1000);
      await persist(connectionId, {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken || conn.refreshToken,
        expiresAt: expiry,
      });
      return { accessToken: tokens.accessToken, accountId: conn.accountId };
    } catch (error) {
      if (error instanceof InvalidGrantError) {
        await markStatus(connectionId, "expired");
      }
      throw error;
    } finally {
      inflightRefresh.delete(connectionId);
    }
  })();
  inflightRefresh.set(connectionId, run);
  return run;
}
