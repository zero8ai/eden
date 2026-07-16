/**
 * Shared connection connect/callback flow (issues #30, #163) — the provider-parameterized loader
 * bodies behind BOTH the generic /connections/:provider/* routes and the legacy /google/* alias
 * routes, so the two cannot drift.
 *
 * The calling route module resolves the per-provider seams and passes them as deps:
 *  - callback staging (google keeps its dedicated cookie + /google/callback path; generic routes
 *    use the shared connection-callback staging), and
 *  - operator config + the exchange/userinfo network calls (the google routes pass the
 *    google.server shim's old-signature functions, keeping that module the single mock point for
 *    existing tests; generic routes pass the provider-generic ones).
 * Everything else — tenancy guard, signed state, nonce, PKCE, grant persistence, audit,
 * auto-redeploy — is identical across providers and lives here.
 */
import { sessionLoader } from "~/auth/session.server";
import { redirect, data, type LoaderFunctionArgs } from "react-router";

import type { OAuthClientConfig } from "./config.server";
import type { OAuthCallbackPayload } from "./oauth-callback-staging.server";
import {
  CONNECT_STATE_TTL_MS,
  authorizeUrl,
  codeChallengeS256,
  connectStateKey,
  generateCodeVerifier,
  missingScopes,
  signConnectState,
  verifyConnectState,
  type TokenGrant,
} from "./oauth.server";
import { findGrant, upsertGrant } from "./grants.server";
import {
  consumeOAuthStateNonce,
  createOAuthStateNonce,
} from "./oauth-state.server";
import {
  getProvider,
  providerRedirectPath,
  type ProviderDefinition,
} from "./providers.server";
import { redeployAfterConnect } from "./redeploy.server";
import { listAgents } from "~/db/queries.server";
import { listDrafts } from "~/drafts/drafts.server";
import { getAgentSource } from "~/github/cached.server";
import { publicOrigin } from "~/lib/ingress";
import { safeReturnTo } from "~/lib/signed-state.server";
import { overlayLock, requiredScopesByProvider } from "~/marketplace/lock";
import { requireProject, requireRepo } from "~/project/guard.server";
import { getRuntime } from "~/seams/index.server";

export interface ConnectionFlowData {
  error: string;
  backUrl: string;
  /** Registry label, or the raw URL id when the provider isn't registered. */
  providerLabel: string;
}

export interface ConnectFlowDeps {
  /** Operator client config for the provider, or null when unconfigured. */
  getConfig: (provider: ProviderDefinition) => OAuthClientConfig | null;
}

export interface CallbackFlowDeps extends ConnectFlowDeps {
  isStagingRequest: (request: Request) => boolean;
  stage: (request: Request) => Response;
  readStaged: (request: Request) => OAuthCallbackPayload | null;
  exchangeCode: (input: {
    provider: ProviderDefinition;
    config: OAuthClientConfig;
    code: string;
    redirectUri: string;
    codeVerifier?: string;
  }) => Promise<TokenGrant>;
  fetchAccountEmail: (
    provider: ProviderDefinition,
    accessToken: string,
  ) => Promise<string | null>;
}

function unknownProviderError(providerId: string): string {
  return (
    `"${providerId}" is not a connection provider this Eden installation supports. ` +
    "Check the connection template's provider id, or update Eden to a version that " +
    "registers this provider."
  );
}

/**
 * Append query params to a same-origin relative path (`backUrl` is already validated by
 * `safeReturnTo`). Parsed against a dummy base so `URL`/`URLSearchParams` do the encoding; only the
 * path + search are returned, so the dummy origin never leaks into the redirect.
 */
function withParams(backUrl: string, params: Record<string, string>): string {
  const url = new URL(backUrl, "http://x");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.pathname + url.search;
}

/**
 * Step 1: sign a (project, agent, Better Auth user/session, provider, scopes, returnTo) state and
 * redirect the user to the provider's OAuth consent screen for Eden's shared client. After
 * approval, the provider returns to its registered callback path, which exchanges the code and
 * stores the grant.
 */
export function connectionConnectLoader(
  args: LoaderFunctionArgs,
  providerId: string,
  deps: ConnectFlowDeps,
) {
  return sessionLoader(
    args,
    async ({ auth }): Promise<ConnectionFlowData> => {
      const url = new URL(args.request.url);
      const projectId = url.searchParams.get("project") ?? "";
      const agentName = url.searchParams.get("agent") ?? "";
      const returnTo =
        safeReturnTo(url.searchParams.get("returnTo")) ?? "/dashboard";

      const provider = getProvider(providerId);
      if (!provider) {
        return {
          error: unknownProviderError(providerId),
          backUrl: returnTo,
          providerLabel: providerId,
        };
      }

      const project = requireRepo(await requireProject(auth, projectId));

      const roster = (await listAgents(project.id)).filter(
        (a) => a.kind === "member",
      );
      const agent = roster.find((a) => a.name === agentName);
      if (!agent) throw data("Unknown agent", { status: 404 });
      const backUrl = returnTo;

      const config = deps.getConfig(provider);
      if (!config) {
        return {
          error:
            `This Eden installation has no ${provider.label} OAuth client configured. An operator must set ` +
            `EDEN_${provider.envPrefix}_CLIENT_ID and EDEN_${provider.envPrefix}_CLIENT_SECRET on the control plane (see the ` +
            `self-host docs) before ${provider.label} can be connected.`,
          backUrl,
          providerLabel: provider.label,
        };
      }

      // Derive requested scopes from Eden's server-side install ledger. Query parameters are
      // attacker-controlled and must never widen the consent requested by the shared OAuth client.
      // Old lock entries predate the auth snapshot, so a stored grant is their trusted fallback.
      const [source, drafts, existingGrant] = await Promise.all([
        getAgentSource(project.repoInstallationId, {
          owner: project.repoOwner,
          repo: project.repoName,
        }),
        listDrafts(project.id),
        findGrant({
          projectId: project.id,
          agentId: agent.id,
          provider: provider.id,
        }),
      ]);
      const lock = overlayLock(
        source.files["eden-lock.json"] ?? null,
        drafts.map((draft) => ({
          path: draft.path,
          content: draft.content,
        })),
      );
      const requiredScopes = requiredScopesByProvider(
        lock,
        agent.root === "agent" ? null : agent.name,
      ).get(provider.id);
      const scopes =
        requiredScopes && requiredScopes.length > 0
          ? requiredScopes.join(" ")
          : (existingGrant?.scopes.trim() ?? "");

      if (!scopes) {
        return {
          error:
            "No scopes were requested for this connection — nothing to authorize.",
          backUrl,
          providerLabel: provider.label,
        };
      }

      const expiresAt = Date.now() + CONNECT_STATE_TTL_MS;
      const nonce = await createOAuthStateNonce({
        userId: auth.user.id,
        sessionId: auth.session.id,
        expiresAt: new Date(expiresAt),
      });
      // PKCE (RFC 7636): the verifier rides inside the HMAC-signed state — it only ever
      // round-trips through the user's redirect, the same trust model as the nonce.
      const codeVerifier = provider.pkce ? generateCodeVerifier() : undefined;
      const state = signConnectState(
        {
          projectId: project.id,
          agentId: agent.id,
          userId: auth.user.id,
          sessionId: auth.session.id,
          nonce,
          provider: provider.id,
          scopes,
          returnTo,
          exp: expiresAt,
          ...(codeVerifier ? { codeVerifier } : {}),
        },
        connectStateKey(),
      );
      const redirectUri = `${publicOrigin(args.request)}${providerRedirectPath(provider)}`;
      throw redirect(
        authorizeUrl(provider, {
          clientId: config.clientId,
          redirectUri,
          state,
          scopes,
          ...(codeVerifier
            ? { codeChallenge: codeChallengeS256(codeVerifier) }
            : {}),
        }),
      );
    },
    { ensureSignedIn: true },
  );
}

/**
 * Step 2: the provider redirects back after consent with the signed `?state=` and a `?code=` (or
 * an `?error=` if the user declined). Verifies the state + tenancy, exchanges the code for a
 * refresh token against Eden's shared client, fetches the account email for display (when the
 * provider has a userinfo endpoint), seals and stores the grant, and returns the user to the
 * wizard/Deployment tab it came from. Mirrors the Discord callback's readable-error (`fail`)
 * pattern.
 */
export function connectionCallbackLoader(
  args: LoaderFunctionArgs,
  providerId: string,
  deps: CallbackFlowDeps,
) {
  // The provider's response contains a one-time authorization code and signed state. Leave that
  // URL before session/database work so credentials never survive in history, logs, rendered
  // errors, or a framework error document. The encrypted HttpOnly cookie is cleared by root
  // middleware.
  if (deps.isStagingRequest(args.request)) {
    return deps.stage(args.request);
  }

  return sessionLoader(
    args,
    async ({ auth }): Promise<ConnectionFlowData> => {
      const provider = getProvider(providerId);
      const label = provider?.label ?? providerId;

      const fail = (
        error: string,
        backUrl = "/dashboard",
      ): ConnectionFlowData => ({
        error,
        backUrl,
        providerLabel: label,
      });

      if (!provider) {
        return fail(unknownProviderError(providerId));
      }

      // A staging failure is authoritative. Never allow an older valid cookie to be processed
      // after a malformed/oversized callback has replaced it.
      const stagingFailed = new URL(args.request.url).searchParams.has(
        "failure",
      );
      const callback = stagingFailed ? null : deps.readStaged(args.request);

      if (!callback?.state) {
        return fail(
          `This ${label} callback is invalid or has expired. Start again from the agent's ` +
            "install page or Deployment tab.",
        );
      }
      const state = verifyConnectState(callback.state, connectStateKey());
      // The provider pin keeps a signed state for one provider from driving another provider's
      // exchange (and vice versa) — the registry validation in verify is not enough.
      if (!state || state.provider !== provider.id) {
        return fail(
          "This link is invalid or has expired (it lives one hour). Start again from the " +
            "agent's install page or Deployment tab.",
        );
      }
      if (
        state.userId !== auth.user.id ||
        state.sessionId !== auth.session.id
      ) {
        return fail(
          `This ${label} connection was started in a different Eden session. Start again from ` +
            "the agent's install page or Deployment tab.",
        );
      }

      // Consume before exchanging the authorization code. DELETE ... RETURNING makes concurrent
      // callbacks race safely: exactly one request can proceed, even across multiple app replicas.
      const consumed = await consumeOAuthStateNonce({
        nonce: state.nonce,
        userId: auth.user.id,
        sessionId: auth.session.id,
      });
      if (!consumed) {
        return fail(
          `This ${label} connection link is invalid, expired, or has already been used. Start ` +
            "again from the agent's install page or Deployment tab.",
        );
      }

      if (callback.error) {
        return fail(
          `${label} authorization was cancelled or denied — the connection was not made. ` +
            "Start again from the agent's install page or Deployment tab.",
        );
      }
      if (!callback.code) {
        return fail(
          `${label} didn't send back an authorization code — the connection was not made. ` +
            "Start again from the agent's install page or Deployment tab.",
        );
      }

      // Tenancy: the signed state names the project, but the SESSION must own it too.
      const project = await requireProject(auth, state.projectId);
      const backUrl = safeReturnTo(state.returnTo) ?? "/dashboard";

      const roster = (await listAgents(project.id)).filter(
        (a) => a.kind === "member",
      );
      const agent = roster.find((a) => a.id === state.agentId);
      if (!agent) {
        return fail("This agent no longer exists in the project.", backUrl);
      }

      const config = deps.getConfig(provider);
      if (!config) {
        return fail(
          `This Eden installation no longer has a ${label} OAuth client configured — ask an ` +
            `operator to set the EDEN_${provider.envPrefix}_* env vars.`,
          backUrl,
        );
      }

      const redirectUri = `${publicOrigin(args.request)}${providerRedirectPath(provider)}`;
      let grant;
      try {
        grant = await deps.exchangeCode({
          provider,
          config,
          code: callback.code,
          redirectUri,
          ...(state.codeVerifier ? { codeVerifier: state.codeVerifier } : {}),
        });
      } catch (error) {
        return fail((error as Error).message, backUrl);
      }

      // Granular consent (issue #30): Google lets the user UNCHECK individual scopes on the consent
      // screen. Storing a partial grant as "active" would 403 at runtime — a silent dead-end — so we
      // refuse it here and tell the user to reconnect with every requested permission left checked.
      const missing = missingScopes(state.scopes, grant.scope);
      if (missing.length > 0) {
        return fail(
          `${label} connected, but the following permission was not granted: ${missing.join(", ")}. ` +
            "Reconnect and leave all requested permissions checked.",
          backUrl,
        );
      }

      const accountEmail = await deps.fetchAccountEmail(
        provider,
        grant.accessToken,
      );

      await upsertGrant({
        projectId: project.id,
        agentId: agent.id,
        provider: provider.id,
        accountEmail,
        scopes: grant.scope || state.scopes,
        refreshToken: grant.refreshToken,
        createdBy: auth.user.id,
      });

      await getRuntime().data.audit.record({
        orgId: project.orgId,
        actorUserId: auth.user.id,
        action: "connection.connect",
        target: agent.name,
        meta: {
          provider: provider.id,
          accountEmail,
          scopes: grant.scope || state.scopes,
        },
      });

      // Auto-redeploy (issue #69): the grant only reaches the RUNNING container on the next deploy,
      // so the connect action itself redeploys every live environment (image reused, fresh grant
      // re-injected). The helper never throws — queue errors come back as an "error" outcome — but
      // wrap defensively so an unexpected reject can never lose the just-saved grant.
      let outcome: Awaited<ReturnType<typeof redeployAfterConnect>>;
      try {
        outcome = await redeployAfterConnect({
          projectId: project.id,
          agentId: agent.id,
          createdBy: auth.user.id,
        });
      } catch {
        throw redirect(withParams(backUrl, { connected: provider.id }));
      }

      const params: Record<string, string> = { connected: provider.id };
      if (outcome.status === "redeployed") params.redeploy = "queued";
      else if (outcome.status === "staged") params.redeploy = "staged";
      else if (outcome.status === "error") {
        params.redeploy = "error";
        params.redeployError = outcome.message.slice(0, 200);
      }
      throw redirect(withParams(backUrl, params));
    },
    // OAuth state is bound to the initiating Better Auth session. If that session expired, the
    // round-trip cannot safely resume; keep the provider's code/state out of the login returnTo
    // URL.
    { ensureSignedIn: true, returnTo: "/dashboard" },
  );
}
