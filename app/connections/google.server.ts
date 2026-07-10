/**
 * Google OAuth broker (issue #30) — the pure URL/state shapes plus the code→token network calls.
 *
 * Eden owns ONE Google OAuth client per installation (operator-registered, EDEN_GOOGLE_*). The
 * install wizard sends the user through Google's consent screen for that client; Google redirects
 * back to /google/callback with a `code`, which this module exchanges server-side for a refresh
 * token (the durable grant Eden seals in `connection_grants`). Unlike Discord — where the connect
 * proof is a bot-token side effect and no code is ever exchanged — Google REQUIRES a real
 * code→token exchange with the client id + secret. That's the new surface here.
 *
 * Everything shape-like is exported pure so tests assert the literals; the two network helpers take
 * an injected `fetchImpl` (default `fetch`). The signed state uses the shared signed-state helper
 * keyed by the same tenant-wide secrets key that seals secrets (no new key to provision).
 */
import { decodeKey } from "~/seams/oss/secretbox";
import { safeReturnTo, signState, verifyState } from "~/lib/signed-state.server";
import { getProvider } from "./providers.server";

/** OpenID scopes appended to every request so we can display the connected account. */
export const GOOGLE_IDENTITY_SCOPES = ["openid", "email"];

export const CONNECT_STATE_TTL_MS = 60 * 60 * 1000;

/* ─────────────────────────── state token (pure given key) ─────────────────────────── */

export interface GoogleConnectState {
  projectId: string;
  agentId: string;
  provider: string;
  /** Space-separated scopes requested (as the connector declared them). */
  scopes: string;
  /** Same-origin relative path to return to after the round-trip. */
  returnTo: string;
  /** Unix ms after which the token is dead. */
  exp: number;
}

/** The HMAC key: the same tenant-wide key that seals secrets. */
export function connectStateKey(): Buffer {
  return decodeKey(process.env.EDEN_SECRETS_KEY);
}

/** Sign a connect state. `returnTo` must already be a validated same-origin path. */
export function signConnectState(state: GoogleConnectState, key: Buffer): string {
  return signState(state, key);
}

/**
 * Verify signature + expiry AND re-validate every field (including that `returnTo` is still a
 * same-origin relative path — belt and suspenders against a signing bug or key reuse). Null on
 * anything off; never throws on malformed input.
 */
export function verifyConnectState(
  token: string,
  key: Buffer,
  now: number = Date.now(),
): GoogleConnectState | null {
  const parsed = verifyState<GoogleConnectState>(token, key, now);
  if (!parsed) return null;
  if (
    typeof parsed.projectId !== "string" ||
    typeof parsed.agentId !== "string" ||
    typeof parsed.provider !== "string" ||
    typeof parsed.scopes !== "string" ||
    typeof parsed.returnTo !== "string" ||
    typeof parsed.exp !== "number"
  ) {
    return null;
  }
  if (safeReturnTo(parsed.returnTo) === null) return null;
  return parsed;
}

/* ─────────────────────────────── authorize URL (pure) ─────────────────────────────── */

export interface GoogleAuthorizeUrlInput {
  clientId: string;
  redirectUri: string;
  state: string;
  /** Connector-declared scopes (space-separated or array); identity scopes are added here. */
  scopes: string | string[];
}

/**
 * Google's OAuth 2.0 authorize URL. `access_type=offline` + `prompt=consent` guarantee a refresh
 * token even on re-consent (Google only returns one when explicitly asked); `openid email` are
 * folded in so the callback can name the connected account. Deduped, stable scope order.
 */
export function googleAuthorizeUrl(input: GoogleAuthorizeUrlInput): string {
  const requested = Array.isArray(input.scopes)
    ? input.scopes
    : input.scopes.split(/\s+/).filter(Boolean);
  const scopes: string[] = [];
  for (const s of [...requested, ...GOOGLE_IDENTITY_SCOPES]) {
    if (!scopes.includes(s)) scopes.push(s);
  }
  const endpoints = getProvider("google")!;
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: scopes.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: input.state,
  });
  return `${endpoints.authorizeUrl}?${params.toString()}`;
}

/* ─────────────────────────────── token exchange (network) ─────────────────────────── */

export interface GoogleTokenGrant {
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
 * Exchange an authorization code for tokens. Throws a readable Error on a non-2xx response or when
 * Google returns no refresh_token (which happens if consent was previously granted without
 * `prompt=consent` — we always send it, so this is a real misconfiguration worth surfacing).
 */
export async function exchangeCode(
  input: {
    config: { clientId: string; clientSecret: string };
    code: string;
    redirectUri: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<GoogleTokenGrant> {
  const endpoints = getProvider("google")!;
  const res = await fetchImpl(endpoints.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      client_id: input.config.clientId,
      client_secret: input.config.clientSecret,
      redirect_uri: input.redirectUri,
    }).toString(),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Google rejected the token exchange (HTTP ${res.status})${body ? `: ${body}` : "."}`,
    );
  }
  const body = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!body.access_token) {
    throw new Error("Google's token response is missing an access_token.");
  }
  if (!body.refresh_token) {
    throw new Error(
      "Google returned no refresh token. Remove Eden's access at " +
        "myaccount.google.com/permissions and connect again so Google re-issues one.",
    );
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresIn: body.expires_in ?? 3599,
    scope: body.scope ?? "",
  };
}

/** Best-effort account email from the OIDC userinfo endpoint (display only). Null on any failure. */
export async function fetchAccountEmail(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const endpoints = getProvider("google")!;
    const res = await fetchImpl(endpoints.userinfoUrl, {
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
 * Exchange a refresh token for a fresh access token. Throws `InvalidGrantError` when Google
 * reports `invalid_grant` (the refresh token is dead — revoked, expired, or the 7-day Testing-mode
 * cap) so the caller can mark the grant expired and prompt a reconnect; throws a plain Error on any
 * other failure (transient, worth a retry). This is the same grant the shipped connection file
 * runs at runtime — kept here too so deploy can validate a grant before injecting it.
 */
export async function refreshAccessToken(
  input: {
    config: { clientId: string; clientSecret: string };
    refreshToken: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<{ accessToken: string; expiresIn: number }> {
  const endpoints = getProvider("google")!;
  const res = await fetchImpl(endpoints.tokenUrl, {
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
        "Google refused the refresh token (invalid_grant) — the connection is no longer valid.",
      );
    }
    throw new Error(
      `Google rejected the token refresh (HTTP ${res.status})${body ? `: ${body}` : "."}`,
    );
  }
  const body = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!body.access_token) {
    throw new Error("Google's refresh response is missing an access_token.");
  }
  return { accessToken: body.access_token, expiresIn: body.expires_in ?? 3599 };
}
