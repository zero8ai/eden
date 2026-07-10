/**
 * Operator config for Eden's shared Google OAuth client (issue #30). A self-host installation
 * registers ONE OAuth 2.0 Client in Google Cloud Console and sets its two credentials as
 * control-plane env. The connect flow exchanges codes with it, and deploy injects the client
 * creds (alongside the sealed refresh token) so the shipped connection self-refreshes tokens.
 * The client secret NEVER leaves the control plane except as an injected env var on the agent's
 * own instance (which needs it for the refresh grant).
 *
 * Null unless both are present — a partial config can't drive any Google operation, and treating
 * it as "unconfigured" keeps the connector's Connect button honestly disabled. Mirrors
 * app/discord/config.server.ts.
 */
export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
}

/** The shared Google client's config, or null when the operator hasn't set both env vars. */
export function getGoogleOAuthConfig(): GoogleOAuthConfig | null {
  const clientId = process.env.EDEN_GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.EDEN_GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}
