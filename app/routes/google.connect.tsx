/**
 * "Connect Google" — step 1 of the install-time connection flow (issue #30).
 *
 * Signs a (project, agent, provider, scopes, returnTo) state and redirects the user to Google's
 * OAuth consent screen for Eden's shared client. After they approve, Google returns to
 * /google/callback, which exchanges the code and stores the grant. Mirrors the Discord connect
 * start route (authkitLoader + requireProject tenancy + readable-error fallback).
 */
import { authkitLoader } from "@workos-inc/authkit-react-router";
import { Plug } from "lucide-react";
import { Link, data, redirect, type LoaderFunctionArgs } from "react-router";

import { AppShell, PageHeader } from "~/components/shell";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { getGoogleOAuthConfig } from "~/connections/config.server";
import {
  CONNECT_STATE_TTL_MS,
  connectStateKey,
  googleAuthorizeUrl,
  signConnectState,
} from "~/connections/google.server";
import { listAgents } from "~/db/queries.server";
import { publicOrigin } from "~/lib/ingress";
import { noindexMeta } from "~/lib/seo";
import { safeReturnTo } from "~/lib/signed-state.server";
import { requireProject } from "~/project/guard.server";
import type { Route } from "./+types/google.connect";

interface GoogleConnectData {
  error: string;
  backUrl: string;
}

export const loader = (args: LoaderFunctionArgs) =>
  authkitLoader(
    args,
    async ({ auth }): Promise<GoogleConnectData> => {
      const url = new URL(args.request.url);
      const projectId = url.searchParams.get("project") ?? "";
      const agentName = url.searchParams.get("agent") ?? "";
      const scopes = (url.searchParams.get("scopes") ?? "").trim();
      const returnTo = safeReturnTo(url.searchParams.get("returnTo")) ?? "/dashboard";

      const project = await requireProject(
        {
          user: auth.user,
          organizationId: auth.organizationId ?? null,
          role: auth.role ?? null,
        },
        projectId,
      );

      const roster = (await listAgents(project.id)).filter(
        (a) => a.kind === "member",
      );
      const agent = roster.find((a) => a.name === agentName);
      if (!agent) throw data("Unknown agent", { status: 404 });

      const backUrl = returnTo;

      if (!scopes) {
        return {
          error: "No scopes were requested for this connection — nothing to authorize.",
          backUrl,
        };
      }

      const config = getGoogleOAuthConfig();
      if (!config) {
        return {
          error:
            "This Eden installation has no Google OAuth client configured. An operator must set " +
            "EDEN_GOOGLE_CLIENT_ID and EDEN_GOOGLE_CLIENT_SECRET on the control plane (see the " +
            "self-host docs) before Google can be connected.",
          backUrl,
        };
      }

      const state = signConnectState(
        {
          projectId: project.id,
          agentId: agent.id,
          provider: "google",
          scopes,
          returnTo,
          exp: Date.now() + CONNECT_STATE_TTL_MS,
        },
        connectStateKey(),
      );
      const redirectUri = `${publicOrigin(args.request)}/google/callback`;
      throw redirect(
        googleAuthorizeUrl({
          clientId: config.clientId,
          redirectUri,
          state,
          scopes,
        }),
      );
    },
    { ensureSignedIn: true },
  );

export function meta() {
  return [{ title: "Connect Google · eden" }, ...noindexMeta];
}

export default function GoogleConnect({ loaderData }: Route.ComponentProps) {
  const { error, backUrl } = loaderData;
  return (
    <AppShell>
      <PageHeader
        icon={Plug}
        accent="brand"
        title="Connect Google"
        description="Authorize this agent to use your Google account."
        actions={
          <Button variant="ghost" asChild>
            <Link to={backUrl}>← Back</Link>
          </Button>
        }
      />
      <Alert variant="destructive">
        <AlertTitle>Can&rsquo;t start the Google connect flow</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    </AppShell>
  );
}
