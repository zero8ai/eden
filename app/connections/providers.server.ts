/**
 * Connector provider registry (issues #30, #163) — everything Eden needs to broker OAuth against
 * a provider, keyed by provider id. Registering a new provider is a data addition here plus the
 * operator's `EDEN_<PREFIX>_CLIENT_ID`/`_CLIENT_SECRET` env vars — no new routes, flows, or schema.
 * Unknown provider → null.
 */
export interface ProviderDefinition {
  /** Registry key and the `auth.provider` string connection templates use. */
  id: string;
  /** Display name for the Connections card and connect/consent UI. */
  label: string;
  authorizeUrl: string;
  tokenUrl: string;
  /** OIDC-ish userinfo endpoint, best-effort display of the connected account. */
  userinfoUrl?: string;
  /** Send PKCE (S256 code_challenge on authorize, code_verifier on exchange). */
  pkce?: boolean;
  /** Extra static authorize params, appended in insertion order after response_type/scope. */
  authorizeParams?: Record<string, string>;
  /** Identity scopes appended so the callback can name the account. */
  identityScopes?: string[];
  /** Env prefix: operator `EDEN_<PREFIX>_CLIENT_ID/SECRET`, injected `<PREFIX>_OAUTH_*`. */
  envPrefix: string;
  /**
   * Redirect path this provider's OAuth app has registered. Defaults to
   * `/connections/<id>/callback`. Google overrides with "/google/callback" (back-compat:
   * operators' Google apps registered that URI; no operator action required).
   */
  redirectPath?: string;
  /** Extra remediation appended to the "no refresh token" exchange error (Google's myaccount hint). */
  noRefreshTokenHint?: string;
}

const PROVIDERS: Record<string, ProviderDefinition> = {
  google: {
    id: "google",
    label: "Google",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userinfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
    // access_type=offline + prompt=consent guarantee a refresh token even on re-consent (Google
    // only returns one when explicitly asked).
    authorizeParams: {
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
    },
    identityScopes: ["openid", "email"],
    envPrefix: "GOOGLE",
    redirectPath: "/google/callback",
    noRefreshTokenHint:
      "Remove Eden's access at myaccount.google.com/permissions and connect again so Google re-issues one.",
  },
};

/** The provider definition for an id, or null when it isn't a known connector. */
export function getProvider(id: string): ProviderDefinition | null {
  return PROVIDERS[id] ?? null;
}

/** Every registered provider (deploy iterates these for per-provider grant injection). */
export function listProviders(): ProviderDefinition[] {
  return Object.values(PROVIDERS);
}

/** The redirect path the provider's OAuth app expects Eden to use. */
export function providerRedirectPath(provider: ProviderDefinition): string {
  return provider.redirectPath ?? `/connections/${provider.id}/callback`;
}
