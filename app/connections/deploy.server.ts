/**
 * Deploy-side connection injection (issues #30, #163). Turns an agent's active OAuth grants into
 * the env the shipped eve connections need to self-refresh access tokens at runtime — per
 * registered provider, the operator client creds plus the sealed refresh token (unsealed here) as
 * `<PREFIX>_OAUTH_CLIENT_ID` / `<PREFIX>_OAUTH_CLIENT_SECRET` / `<PREFIX>_OAUTH_REFRESH_TOKEN`,
 * plus `<PREFIX>_OAUTH_SCOPES` — the grant's GRANTED scopes (issue #165) so agent code can read
 * its actual permission level. There is NO per-turn control-plane dependency: once these vars are
 * in the container, eve's `getToken` exchanges the refresh token for access tokens on its own.
 *
 * Each grant is VALIDATED once at deploy by attempting a refresh: a dead grant (invalid_grant) is
 * marked "expired" and the deploy fails honestly with a reconnect message, rather than shipping a
 * container that can never authenticate. A transient refresh failure throws too (deploys should be
 * repeatable), but leaves the grant active.
 *
 * When the caller supplies the installed connectors' required scopes (issue #69), it ALSO validates
 * scope COVERAGE per provider: an active grant whose granted scopes don't cover what the installs
 * require would 403 at runtime, so the deploy fails honestly with a "reconnect" message instead.
 * The grant stays active (it isn't dead — just under-scoped), so it is NOT marked expired.
 *
 * The persistence + config touchpoints are injectable (`ConnectionDeployDeps`) so the decision
 * logic is unit-testable with fakes; the default wiring hits Postgres + operator env.
 */
import type { SecretScope } from "~/seams/types";
import {
  getProviderOAuthConfig,
  type OAuthClientConfig,
} from "./config.server";
import {
  InvalidGrantError,
  missingScopes,
  refreshAccessToken as realRefreshAccessToken,
} from "./oauth.server";
import { getProvider, type ProviderDefinition } from "./providers.server";
import {
  listGrantsForAgent as realListGrantsForAgent,
  markGrantStatus as realMarkGrantStatus,
  openRefreshToken as realOpenRefreshToken,
  type GrantStatus,
} from "./grants.server";

export interface ConnectionDeployDeps {
  getConfig: (provider: ProviderDefinition) => OAuthClientConfig | null;
  /** Display-safe grant rows — enumeration only (which providers have a grant at all). */
  listGrantsForAgent: (
    agentId: string,
  ) => Promise<{ provider: string; status: GrantStatus }[]>;
  openRefreshToken: (input: {
    projectId: string;
    agentId: string;
    provider: string;
  }) => Promise<{
    grant: { id: string; status: GrantStatus; scopes: string };
    refreshToken: string;
    /** Opaque fingerprint of THIS token, for compare-and-set status flips. */
    tokenVersion?: string;
  } | null>;
  markGrantStatus: (
    id: string,
    status: GrantStatus,
    expectedTokenVersion?: string,
  ) => Promise<void>;
  refreshAccessToken: (
    input: {
      provider: ProviderDefinition;
      config: OAuthClientConfig;
      refreshToken: string;
    },
    fetchImpl: typeof fetch,
  ) => Promise<{ accessToken: string; expiresIn: number }>;
}

function defaultDeps(): ConnectionDeployDeps {
  return {
    getConfig: getProviderOAuthConfig,
    listGrantsForAgent: realListGrantsForAgent,
    openRefreshToken: realOpenRefreshToken,
    markGrantStatus: realMarkGrantStatus,
    refreshAccessToken: realRefreshAccessToken,
  };
}

/**
 * Resolve the connection env for a deploy scope across every provider the agent has a grant for
 * or the lock requires, or `{}` when nothing injects (no active grants, or the operator hasn't
 * configured the providers' shared clients). Validates each grant with a single refresh; throws a
 * readable Error if one is dead (after marking it expired) or under-scoped.
 */
export async function connectionGrantEnv(
  scope: SecretScope,
  fetchImpl: typeof fetch = fetch,
  deps: ConnectionDeployDeps = defaultDeps(),
  requiredScopes: ReadonlyMap<string, string[]> | null = null,
): Promise<Record<string, string>> {
  // Grants are per-agent; a scope without a concrete agent (shouldn't happen at deploy) has none.
  if (!scope.agentId) return {};

  // Union of "has a grant row" and "the lock requires it" — a lock-required provider with a dead
  // or missing grant must still be considered (its coverage/liveness failures surface elsewhere),
  // and a granted provider the lock no longer names keeps injecting (grants are the authority).
  const grants = await deps.listGrantsForAgent(scope.agentId);
  const providerIds = [
    ...new Set([
      ...grants.map((g) => g.provider),
      ...(requiredScopes?.keys() ?? []),
    ]),
  ].sort();

  const env: Record<string, string> = {};
  for (const id of providerIds) {
    // Unregistered id (a stale grant row, or a lock requiring a provider this installation
    // doesn't know) → skip silently; the Connections card handles the messaging.
    const def = getProvider(id);
    if (!def) continue;
    const config = deps.getConfig(def);
    if (!config) continue;

    const found = await deps.openRefreshToken({
      projectId: scope.projectId,
      agentId: scope.agentId,
      provider: def.id,
    });
    if (!found || found.grant.status !== "active") continue;

    try {
      await deps.refreshAccessToken(
        { provider: def, config, refreshToken: found.refreshToken },
        fetchImpl,
      );
    } catch (error) {
      if (error instanceof InvalidGrantError) {
        // Compare-and-set against the token that was actually tested: a reconnect racing this
        // deploy may already have rotated the row to a fresh valid token, which must stay active.
        await deps.markGrantStatus(found.grant.id, "expired", found.tokenVersion);
        throw new Error(
          `The ${def.label} connection for this agent has expired — reconnect it from the agent's ` +
            "install page or Deployment tab, then redeploy.",
        );
      }
      throw error;
    }

    // Scope-coverage validation (issue #69): the grant is alive, but if its granted scopes don't
    // cover what the installed connectors require, the container would 403 at runtime. Fail the
    // deploy honestly. The grant is active (not dead), so it is NOT marked expired here.
    const required = requiredScopes?.get(def.id)?.join(" ");
    if (required) {
      const missing = missingScopes(required, found.grant.scopes);
      if (missing.length > 0) {
        throw new Error(
          `The ${def.label} connection for this agent is missing required permission(s): ${missing.join(", ")}. ` +
            "Reconnect it from the agent's Deployment tab (leave all requested permissions checked), then redeploy.",
        );
      }
    }

    env[`${def.envPrefix}_OAUTH_CLIENT_ID`] = config.clientId;
    env[`${def.envPrefix}_OAUTH_CLIENT_SECRET`] = config.clientSecret;
    env[`${def.envPrefix}_OAUTH_REFRESH_TOKEN`] = found.refreshToken;
    // Agent-side permission visibility (issue #165): the scopes the provider actually GRANTED,
    // space-joined exactly as stored on the grant row, so agent code can tell which permission
    // level it holds (e.g. don't offer to send mail when only read was granted).
    env[`${def.envPrefix}_OAUTH_SCOPES`] = found.grant.scopes;
  }

  return env;
}
