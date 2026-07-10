/**
 * Connector provider registry (issue #30) — the OAuth endpoints Eden brokers against, keyed by
 * provider id. Phase 1 has one entry ("google"); the shape is deliberately tiny so a second
 * provider is a data addition, not a code change. Unknown provider → null.
 */
export interface ProviderEndpoints {
  authorizeUrl: string;
  tokenUrl: string;
  /** OpenID Connect userinfo endpoint — used best-effort to display the connected account. */
  userinfoUrl: string;
}

const PROVIDERS: Record<string, ProviderEndpoints> = {
  google: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userinfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
  },
};

/** The OAuth endpoints for a provider id, or null when it isn't a known connector. */
export function getProvider(id: string): ProviderEndpoints | null {
  return PROVIDERS[id] ?? null;
}
