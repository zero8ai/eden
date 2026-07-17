/**
 * Google OAuth broker compat shim (issues #30, #163). The flow logic moved to the
 * provider-generic oauth.server.ts; this module keeps the Google-era export names (and old
 * Google-bound signatures) alive so existing callers and tests compile unchanged. New code
 * should import from ./oauth.server and pass a ProviderDefinition.
 */
import type { OAuthClientConfig } from "./config.server";
import {
  authorizeUrl,
  exchangeCode as genericExchangeCode,
  fetchAccountEmail as genericFetchAccountEmail,
  refreshAccessToken as genericRefreshAccessToken,
  type ConnectState,
  type TokenGrant,
} from "./oauth.server";
import { getProvider } from "./providers.server";

export {
  CONNECT_STATE_TTL_MS,
  InvalidGrantError,
  connectStateKey,
  connectionRowState,
  missingScopes,
  signConnectState,
  verifyConnectState,
  type ConnectionRowState,
} from "./oauth.server";

/** OpenID scopes appended to every request so we can display the connected account. */
export const GOOGLE_IDENTITY_SCOPES = ["openid", "email"];

/** Google-era name for the generic ConnectState (provider widened from "google" to string). */
export type GoogleConnectState = ConnectState;

export type GoogleTokenGrant = TokenGrant;

export interface GoogleAuthorizeUrlInput {
  clientId: string;
  redirectUri: string;
  state: string;
  /** Connector-declared scopes (space-separated or array); identity scopes are added here. */
  scopes: string | string[];
}

/** Google's OAuth 2.0 authorize URL — the generic builder bound to the google registry entry. */
export function googleAuthorizeUrl(input: GoogleAuthorizeUrlInput): string {
  return authorizeUrl(getProvider("google")!, input);
}

/** Exchange an authorization code for tokens against the google provider. */
export async function exchangeCode(
  input: {
    config: OAuthClientConfig;
    code: string;
    redirectUri: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<GoogleTokenGrant> {
  return genericExchangeCode({ provider: getProvider("google")!, ...input }, fetchImpl);
}

/** Best-effort account email from Google's OIDC userinfo endpoint. Null on any failure. */
export async function fetchAccountEmail(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  return genericFetchAccountEmail(getProvider("google")!, accessToken, fetchImpl);
}

/** Exchange a Google refresh token for a fresh access token (InvalidGrantError on a dead grant). */
export async function refreshAccessToken(
  input: {
    config: OAuthClientConfig;
    refreshToken: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<{ accessToken: string; expiresIn: number }> {
  return genericRefreshAccessToken(
    { provider: getProvider("google")!, ...input },
    fetchImpl,
  );
}
