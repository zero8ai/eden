/**
 * Provider-generic OAuth broker (issues #30, #163) — the pure URL/state shapes plus the
 * code→token network calls, parameterized by a ProviderDefinition from the registry.
 *
 * Eden owns ONE OAuth client per (installation, provider), operator-registered as
 * EDEN_<PREFIX>_*. The connect flow sends the user through the provider's consent screen for
 * that client; the provider redirects back to the registered callback with a `code`, which this
 * module exchanges server-side for a refresh token (the durable grant Eden seals in
 * `connection_grants`). Unlike Discord — where the connect proof is a bot-token side effect and
 * no code is ever exchanged — these providers REQUIRE a real code→token exchange with the client
 * id + secret. Providers that declare `pkce` additionally get an S256 code_challenge on the
 * authorize URL and the code_verifier on the exchange (RFC 7636); the verifier rides inside the
 * HMAC-signed state, which only ever round-trips through the user's redirect — the same trust
 * model as the nonce.
 *
 * Everything shape-like is exported pure so tests assert the literals; the network helpers take
 * an injected `fetchImpl` (default `fetch`). The signed state uses the shared signed-state helper
 * keyed by the same tenant-wide secrets key that seals secrets (no new key to provision).
 */
import { createHash, randomBytes } from "node:crypto";

import { decodeKey } from "~/seams/oss/secretbox";
import {
  safeReturnTo,
  signState,
  verifyState,
} from "~/lib/signed-state.server";
import type { OAuthClientConfig } from "./config.server";
import { getProvider, type ProviderDefinition } from "./providers.server";

export const CONNECT_STATE_TTL_MS = 60 * 60 * 1000;

/**
 * Requested connector scopes that the provider did NOT grant (issue #30). Google's consent screen
 * lets a user UNCHECK individual scopes (granular consent), so `granted` can be a strict subset of
 * what we asked for — an under-scoped grant that 403s at runtime. Both inputs are space-separated.
 * Only the CONNECTOR scopes are compared: identity scopes (openid/email) are appended separately
 * and providers normalize their short names, so callers pass just `state.scopes` here. Lenient
 * when `granted` is empty/absent — a missing field must not hard-fail the connect.
 */
export function missingScopes(requested: string, granted: string): string[] {
  const grantedSet = new Set(granted.split(/\s+/).filter(Boolean));
  if (grantedSet.size === 0) return [];
  const requestedList = requested.split(/\s+/).filter(Boolean);
  return requestedList.filter((s) => !grantedSet.has(s));
}

/**
 * The four states a Deployment-tab Connections row can be in (issue #30). The card is now the ONE
 * place a connector's OAuth account is connected/reconnected — installs no longer gate on it — so a
 * row exists for every provider the lock REQUIRES, even before any grant.
 *  - "not-connected": no grant yet → primary Connect button (requests the lock-required scopes).
 *  - "connected": active grant that covers the required scopes → subtle Reconnect link.
 *  - "under-scoped": active grant missing required scopes (would 403 at runtime) → primary Reconnect.
 *  - "inactive": grant expired/revoked → status badge + Reconnect.
 */
export type ConnectionRowState =
  "not-connected" | "connected" | "under-scoped" | "inactive";

/**
 * Derive a Connections-card row's state from its lock-required scopes and current grant (issue #30).
 * Pure so the route computes it in the loader and ships a plain string to the client — deployments.tsx
 * is a route with client code, so the server-only scope comparison stays out of the render path. A
 * null/absent `requiredScopes` (old locks with no snapshot) is treated as covered.
 */
export function connectionRowState(input: {
  hasGrant: boolean;
  grantStatus: string | null;
  requiredScopes: string | null;
  grantScopes: string;
}): ConnectionRowState {
  if (!input.hasGrant) return "not-connected";
  if (input.grantStatus !== "active") return "inactive";
  if (!input.requiredScopes) return "connected";
  return missingScopes(input.requiredScopes, input.grantScopes).length === 0
    ? "connected"
    : "under-scoped";
}

/* ─────────────────────────── state token (pure given key) ─────────────────────────── */

export interface ConnectState {
  projectId: string;
  agentId: string;
  /** Better Auth user and session that initiated this OAuth round-trip. */
  userId: string;
  sessionId: string;
  /** Random server-recorded nonce consumed atomically by the callback. */
  nonce: string;
  /** Registry provider id — validated against the registry on verify. */
  provider: string;
  /** Space-separated scopes requested (as the connector declared them). */
  scopes: string;
  /** Same-origin relative path to return to after the round-trip. */
  returnTo: string;
  /** Unix ms after which the token is dead. */
  exp: number;
  /** PKCE code_verifier, carried inside the HMAC-signed state (same trust model as nonce). */
  codeVerifier?: string;
}

/** The HMAC key: the same tenant-wide key that seals secrets. */
export function connectStateKey(): Buffer {
  return decodeKey(process.env.EDEN_SECRETS_KEY);
}

/** Sign a connect state. `returnTo` must already be a validated same-origin path. */
export function signConnectState(state: ConnectState, key: Buffer): string {
  return signState(state, key);
}

/**
 * Verify signature + expiry AND re-validate every field (including that `returnTo` is still a
 * same-origin relative path — belt and suspenders against a signing bug or key reuse). The
 * provider must still be registered (the registry is the authority), and a codeVerifier — when
 * present — must be an RFC 7636 §4.1 verifier length (43..128). Null on anything off; never
 * throws on malformed input.
 */
export function verifyConnectState(
  token: string,
  key: Buffer,
  now: number = Date.now(),
): ConnectState | null {
  const parsed = verifyState<ConnectState>(token, key, now);
  if (!parsed) return null;
  if (
    typeof parsed.projectId !== "string" ||
    typeof parsed.agentId !== "string" ||
    typeof parsed.userId !== "string" ||
    typeof parsed.sessionId !== "string" ||
    typeof parsed.nonce !== "string" ||
    typeof parsed.provider !== "string" ||
    getProvider(parsed.provider) === null ||
    typeof parsed.scopes !== "string" ||
    typeof parsed.returnTo !== "string" ||
    typeof parsed.exp !== "number"
  ) {
    return null;
  }
  if (
    parsed.codeVerifier !== undefined &&
    (typeof parsed.codeVerifier !== "string" ||
      parsed.codeVerifier.length < 43 ||
      parsed.codeVerifier.length > 128)
  ) {
    return null;
  }
  if (safeReturnTo(parsed.returnTo) === null) return null;
  return parsed;
}

/* ────────────────────────────────── PKCE (RFC 7636) ───────────────────────────────── */

/** RFC 7636: 32 random bytes base64url = 43 chars, the minimum verifier length. */
export function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

/** The S256 code_challenge for a verifier. */
export function codeChallengeS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/* ─────────────────────────────── authorize URL (pure) ─────────────────────────────── */

export interface AuthorizeUrlInput {
  clientId: string;
  redirectUri: string;
  state: string;
  /** Connector-declared scopes (space-separated or array); identity scopes are added here. */
  scopes: string | string[];
  /** S256 challenge; callers pass it only when the provider declares `pkce`. */
  codeChallenge?: string;
}

/**
 * The provider's OAuth 2.0 authorize URL. Provider quirks live in `authorizeParams` (Google:
 * access_type=offline + prompt=consent guarantee a refresh token even on re-consent) and
 * `identityScopes` (folded in so the callback can name the connected account). Deduped, stable
 * scope order; params emit in insertion order, so Google's query string is byte-for-byte what
 * the Google-only broker produced.
 */
export function authorizeUrl(
  provider: ProviderDefinition,
  input: AuthorizeUrlInput,
): string {
  const requested = Array.isArray(input.scopes)
    ? input.scopes
    : input.scopes.split(/\s+/).filter(Boolean);
  const scopes: string[] = [];
  for (const s of [...requested, ...(provider.identityScopes ?? [])]) {
    if (!scopes.includes(s)) scopes.push(s);
  }
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: scopes.join(" "),
    ...(provider.authorizeParams ?? {}),
    state: input.state,
  });
  if (input.codeChallenge) {
    params.set("code_challenge", input.codeChallenge);
    params.set("code_challenge_method", "S256");
  }
  return `${provider.authorizeUrl}?${params.toString()}`;
}

/* ─────────────────────────────── token exchange (network) ─────────────────────────── */

export interface TokenGrant {
  accessToken: string;
  refreshToken: string;
  /** Access-token lifetime in seconds (Google typically returns 3599). */
  expiresIn: number;
  /** Scopes actually granted, space-separated. */
  scope: string;
}

/** A dead-grant marker so callers (deploy) can distinguish "reconnect needed" from a transient 5xx. */
export class InvalidGrantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidGrantError";
  }
}

/**
 * Exchange an authorization code for tokens. Throws a readable Error on a non-2xx response or
 * when the provider returns no refresh_token (for Google that happens if consent was previously
 * granted without `prompt=consent` — we always send it, so this is a real misconfiguration worth
 * surfacing; the provider's `noRefreshTokenHint` carries the remediation).
 */
export async function exchangeCode(
  input: {
    provider: ProviderDefinition;
    config: OAuthClientConfig;
    code: string;
    redirectUri: string;
    /** PKCE verifier from the signed state; sent as code_verifier when present. */
    codeVerifier?: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<TokenGrant> {
  const { provider } = input;
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    client_id: input.config.clientId,
    client_secret: input.config.clientSecret,
    redirect_uri: input.redirectUri,
  });
  if (input.codeVerifier) form.set("code_verifier", input.codeVerifier);
  const res = await fetchImpl(provider.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `${provider.label} rejected the token exchange (HTTP ${res.status})${body ? `: ${body}` : "."}`,
    );
  }
  const body = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!body.access_token) {
    throw new Error(
      `${provider.label}'s token response is missing an access_token.`,
    );
  }
  if (!body.refresh_token) {
    throw new Error(
      `${provider.label} returned no refresh token.` +
        (provider.noRefreshTokenHint
          ? ` ${provider.noRefreshTokenHint}`
          : ""),
    );
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresIn: body.expires_in ?? 3599,
    scope: body.scope ?? "",
  };
}

/**
 * Best-effort account email from the provider's userinfo endpoint (display only). Null on any
 * failure, and null WITHOUT a request when the provider declares no userinfoUrl.
 */
export async function fetchAccountEmail(
  provider: ProviderDefinition,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  if (!provider.userinfoUrl) return null;
  try {
    const res = await fetchImpl(provider.userinfoUrl, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { email?: string };
    return body.email ?? null;
  } catch {
    return null;
  }
}

/**
 * Exchange a refresh token for a fresh access token. Throws `InvalidGrantError` when the provider
 * reports `invalid_grant` (the refresh token is dead — revoked, expired, or Google's 7-day
 * Testing-mode cap) so the caller can mark the grant expired and prompt a reconnect; throws a
 * plain Error on any other failure (transient, worth a retry). This is the same grant the shipped
 * connection file runs at runtime — kept here too so deploy can validate a grant before injecting
 * it.
 */
export async function refreshAccessToken(
  input: {
    provider: ProviderDefinition;
    config: OAuthClientConfig;
    refreshToken: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<{ accessToken: string; expiresIn: number }> {
  const { provider } = input;
  const res = await fetchImpl(provider.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
      client_id: input.config.clientId,
      client_secret: input.config.clientSecret,
    }).toString(),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 400 && /invalid_grant/.test(body)) {
      throw new InvalidGrantError(
        `${provider.label} refused the refresh token (invalid_grant) — the connection is no longer valid.`,
      );
    }
    throw new Error(
      `${provider.label} rejected the token refresh (HTTP ${res.status})${body ? `: ${body}` : "."}`,
    );
  }
  const body = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!body.access_token) {
    throw new Error(
      `${provider.label}'s refresh response is missing an access_token.`,
    );
  }
  return { accessToken: body.access_token, expiresIn: body.expires_in ?? 3599 };
}
