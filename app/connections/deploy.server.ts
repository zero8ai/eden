/**
 * Deploy-side connection injection (issue #30). Turns an agent's active Google grant into the env
 * the shipped eve OpenAPI connection needs to self-refresh access tokens at runtime — the operator
 * client creds plus the sealed refresh token (unsealed here). There is NO per-turn control-plane
 * dependency: once these three vars are in the container, eve's `getToken` exchanges the refresh
 * token for access tokens on its own.
 *
 * The grant is VALIDATED once at deploy by attempting a refresh: a dead grant (invalid_grant) is
 * marked "expired" and the deploy fails honestly with a reconnect message, rather than shipping a
 * container that can never authenticate. A transient refresh failure throws too (deploys should be
 * repeatable), but leaves the grant active.
 *
 * When the caller supplies the installed connectors' required scopes (issue #69), it ALSO validates
 * scope COVERAGE: an active grant whose granted scopes don't cover what the installs require would
 * 403 at runtime, so the deploy fails honestly with a "reconnect" message instead. The grant stays
 * active (it isn't dead — just under-scoped), so it is NOT marked expired.
 *
 * The persistence + config touchpoints are injectable (`ConnectionDeployDeps`) so the decision
 * logic is unit-testable with fakes; the default wiring hits Postgres + operator env.
 */
import type { SecretScope } from "~/seams/types";
import { getGoogleOAuthConfig, type GoogleOAuthConfig } from "./config.server";
import {
  InvalidGrantError,
  missingScopes,
  refreshAccessToken as realRefreshAccessToken,
} from "./google.server";
import {
  markGrantStatus as realMarkGrantStatus,
  openRefreshToken as realOpenRefreshToken,
  type GrantStatus,
} from "./grants.server";

export interface ConnectionDeployDeps {
  getConfig: () => GoogleOAuthConfig | null;
  openRefreshToken: (input: {
    projectId: string;
    agentId: string;
    provider: string;
  }) => Promise<{
    grant: { id: string; status: GrantStatus; scopes: string };
    refreshToken: string;
  } | null>;
  markGrantStatus: (id: string, status: GrantStatus) => Promise<void>;
  refreshAccessToken: (
    input: { config: GoogleOAuthConfig; refreshToken: string },
    fetchImpl: typeof fetch,
  ) => Promise<{ accessToken: string; expiresIn: number }>;
}

function defaultDeps(): ConnectionDeployDeps {
  return {
    getConfig: getGoogleOAuthConfig,
    openRefreshToken: realOpenRefreshToken,
    markGrantStatus: realMarkGrantStatus,
    refreshAccessToken: realRefreshAccessToken,
  };
}

/**
 * Resolve the Google connection env for a deploy scope, or `{}` when the agent has no active
 * Google grant (or the operator hasn't configured the shared client). Validates the grant with a
 * single refresh; throws a readable Error if it's dead (after marking it expired).
 */
export async function connectionGrantEnv(
  scope: SecretScope,
  fetchImpl: typeof fetch = fetch,
  deps: ConnectionDeployDeps = defaultDeps(),
  requiredScopes: string | null = null,
): Promise<Record<string, string>> {
  const config = deps.getConfig();
  if (!config) return {};
  // Grants are per-agent; a scope without a concrete agent (shouldn't happen at deploy) has none.
  if (!scope.agentId) return {};

  const found = await deps.openRefreshToken({
    projectId: scope.projectId,
    agentId: scope.agentId,
    provider: "google",
  });
  if (!found || found.grant.status !== "active") return {};

  try {
    await deps.refreshAccessToken(
      { config, refreshToken: found.refreshToken },
      fetchImpl,
    );
  } catch (error) {
    if (error instanceof InvalidGrantError) {
      await deps.markGrantStatus(found.grant.id, "expired");
      throw new Error(
        "The Google connection for this agent has expired — reconnect it from the agent's " +
          "install page or Deployment tab, then redeploy.",
      );
    }
    throw error;
  }

  // Scope-coverage validation (issue #69): the grant is alive, but if its granted scopes don't
  // cover what the installed connectors require, the container would 403 at runtime. Fail the
  // deploy honestly. The grant is active (not dead), so it is NOT marked expired here.
  if (requiredScopes) {
    const missing = missingScopes(requiredScopes, found.grant.scopes);
    if (missing.length > 0) {
      throw new Error(
        `The Google connection for this agent is missing required permission(s): ${missing.join(", ")}. ` +
          "Reconnect it from the agent's Deployment tab (leave all requested permissions checked), then redeploy.",
      );
    }
  }

  return {
    GOOGLE_OAUTH_CLIENT_ID: config.clientId,
    GOOGLE_OAUTH_CLIENT_SECRET: config.clientSecret,
    GOOGLE_OAUTH_REFRESH_TOKEN: found.refreshToken,
  };
}
