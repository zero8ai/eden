/**
 * Google connect callback — step 2 of the install-time connection flow (issue #30).
 *
 * Google redirects here after the user consents, with the signed `?state=` and a `?code=` (or an
 * `?error=` if they declined). The loader verifies the state + tenancy, exchanges the code for a
 * refresh token against Eden's shared Google client, fetches the account email for display, seals
 * and stores the grant, and returns the user to the wizard/Deployment tab it came from. Mirrors the
 * Discord callback's readable-error (`fail`) pattern.
 */
import { authkitLoader } from "@workos-inc/authkit-react-router";
import { Plug } from "lucide-react";
import { Link, redirect, type LoaderFunctionArgs } from "react-router";

import { AppShell, PageHeader } from "~/components/shell";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { getGoogleOAuthConfig } from "~/connections/config.server";
import {
  connectStateKey,
  exchangeCode,
  fetchAccountEmail,
  missingScopes,
  verifyConnectState,
} from "~/connections/google.server";
import { upsertGrant } from "~/connections/grants.server";
import { redeployAfterConnect } from "~/connections/redeploy.server";
import { listAgents } from "~/db/queries.server";
import { publicOrigin } from "~/lib/ingress";
import { noindexMeta } from "~/lib/seo";
import { safeReturnTo } from "~/lib/signed-state.server";
import { requireProject } from "~/project/guard.server";
import { getRuntime } from "~/seams/index.server";
import type { Route } from "./+types/google.callback";

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

export const loader = (args: LoaderFunctionArgs) =>
  authkitLoader(
    args,
    async ({ auth }) => {
      const url = new URL(args.request.url);
      const stateToken = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      const oauthError = url.searchParams.get("error");

      const fail = (error: string, backUrl = "/dashboard") => ({ error, backUrl });

      if (oauthError) {
        return fail(
          "Google authorization was cancelled or denied — the connection was not made. " +
            "Start again from the agent's install page or Deployment tab.",
        );
      }
      if (!stateToken || !code) {
        return fail(
          "Google didn't send back an authorization code — the connection was not made. " +
            "Start again from the agent's install page or Deployment tab.",
        );
      }
      const state = verifyConnectState(stateToken, connectStateKey());
      if (!state) {
        return fail(
          "This link is invalid or has expired (it lives one hour). Start again from the " +
            "agent's install page or Deployment tab.",
        );
      }

      // Tenancy: the signed state names the project, but the SESSION must own it too.
      const project = await requireProject(
        {
          user: auth.user,
          organizationId: auth.organizationId ?? null,
          role: auth.role ?? null,
        },
        state.projectId,
      );
      const backUrl = safeReturnTo(state.returnTo) ?? "/dashboard";

      const roster = (await listAgents(project.id)).filter(
        (a) => a.kind === "member",
      );
      const agent = roster.find((a) => a.id === state.agentId);
      if (!agent) {
        return fail("This agent no longer exists in the project.", backUrl);
      }

      const config = getGoogleOAuthConfig();
      if (!config) {
        return fail(
          "This Eden installation no longer has a Google OAuth client configured — ask an " +
            "operator to set the EDEN_GOOGLE_* env vars.",
          backUrl,
        );
      }

      const redirectUri = `${publicOrigin(args.request)}/google/callback`;
      let grant;
      try {
        grant = await exchangeCode({ config, code, redirectUri });
      } catch (error) {
        return fail((error as Error).message, backUrl);
      }

      // Granular consent (issue #30): Google lets the user UNCHECK individual scopes on the consent
      // screen. Storing a partial grant as "active" would 403 at runtime — a silent dead-end — so we
      // refuse it here and tell the user to reconnect with every requested permission left checked.
      const missing = missingScopes(state.scopes, grant.scope);
      if (missing.length > 0) {
        return fail(
          `Google connected, but the following permission was not granted: ${missing.join(", ")}. ` +
            "Reconnect and leave all requested permissions checked.",
          backUrl,
        );
      }

      const accountEmail = await fetchAccountEmail(grant.accessToken);

      await upsertGrant({
        projectId: project.id,
        agentId: agent.id,
        provider: "google",
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
        meta: { provider: "google", accountEmail, scopes: grant.scope || state.scopes },
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
        throw redirect(withParams(backUrl, { connected: "google" }));
      }

      const params: Record<string, string> = { connected: "google" };
      if (outcome.status === "redeployed") params.redeploy = "queued";
      else if (outcome.status === "staged") params.redeploy = "staged";
      else if (outcome.status === "error") {
        params.redeploy = "error";
        params.redeployError = outcome.message.slice(0, 200);
      }
      throw redirect(withParams(backUrl, params));
    },
    { ensureSignedIn: true },
  );

export function meta() {
  return [{ title: "Connect Google · eden" }, ...noindexMeta];
}

export default function GoogleCallback({ loaderData }: Route.ComponentProps) {
  const { error, backUrl } = loaderData;
  return (
    <AppShell>
      <PageHeader
        icon={Plug}
        accent="brand"
        title="Connect Google"
        description="Something went wrong while connecting Google."
        actions={
          <Button variant="ghost" asChild>
            <Link to={backUrl}>← Back</Link>
          </Button>
        }
      />
      <Alert variant="destructive">
        <AlertTitle>Google connect failed</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    </AppShell>
  );
}
