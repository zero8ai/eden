/**
 * Control-plane-side access-token cache for CAPABILITY providers (issue #166), keyed per grant
 * scope (`grantRefreshKey`). Xero rotates the refresh token on EVERY refresh and its access
 * tokens live ~30 minutes, so the token from one refresh is reused until shortly before
 * `expiresAt` (broker.server.ts owns that policy).
 *
 * The cache lives in its OWN module — not broker.server.ts — so grant WRITERS can invalidate
 * entries without importing the broker (grants.server.ts is below the broker in the import
 * graph): a reconnect replaces the grant at the same scope, possibly binding a DIFFERENT vendor
 * account, and a token minted under the replaced grant must die with it rather than serve calls
 * for the rest of its lifetime under authorization the installer just replaced.
 *
 * In-memory (single-container control plane, same trust model as the refresh serialization
 * chains); the plaintext never leaves this module except as the returned token.
 */
import { grantRefreshKey } from "./refresh-serialization.server";

export interface CachedCapabilityToken {
  accessToken: string;
  expiresAt: number;
}

const cache = new Map<string, CachedCapabilityToken>();

export function getCachedCapabilityToken(
  key: string,
): CachedCapabilityToken | undefined {
  return cache.get(key);
}

export function setCachedCapabilityToken(
  key: string,
  token: CachedCapabilityToken,
): void {
  cache.set(key, token);
}

export function deleteCachedCapabilityToken(key: string): void {
  cache.delete(key);
}

/**
 * Drop the cached token for ONE grant scope — called by every write that replaces the grant
 * (`upsertGrant` on connect/reconnect), so the very next capability call refreshes against the
 * NEW grant instead of riding the old account's still-live access token.
 */
export function invalidateCapabilityToken(scope: {
  projectId: string;
  agentId: string;
  provider: string;
}): void {
  cache.delete(grantRefreshKey(scope));
}

/** Drop every cached capability access token (tests). */
export function clearCapabilityTokenCache(): void {
  cache.clear();
}
