import { consumeOAuthStateNonce } from "~/connections/oauth-state.server";
import {
  createMobileGithubHandoff,
  exchangeGithubUserCode,
  githubUserCanAccessInstallation,
  mobileGithubErrorUrl,
  mobileGithubHandoffUrl,
  verifyMobileGithubState,
} from "~/github/mobile-install.server";
import { publicOrigin } from "~/lib/ingress";
import { noindexMeta } from "~/lib/seo";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Link, redirect, type LoaderFunctionArgs } from "react-router";
import type { Route } from "./+types/github.mobile-install.callback";

interface CallbackView {
  error: string;
}

export async function loader(args: LoaderFunctionArgs): Promise<CallbackView> {
  const url = new URL(args.request.url);
  const state = verifyMobileGithubState(url.searchParams.get("state") ?? "");
  if (!state || state.phase !== "verify") {
    return {
      error:
        "This GitHub authorization is invalid or expired. Start again in Eden.",
    };
  }
  const consumed = await consumeOAuthStateNonce({
    nonce: state.nonce,
    userId: state.userId,
    sessionId: state.sessionId,
  });
  if (!consumed) {
    throw redirect(mobileGithubErrorUrl(state.redirectUrl, "expired"));
  }
  if (url.searchParams.get("error")) {
    throw redirect(mobileGithubErrorUrl(state.redirectUrl, "cancelled"));
  }
  const code = url.searchParams.get("code");
  if (!code) {
    throw redirect(
      mobileGithubErrorUrl(state.redirectUrl, "verification_failed"),
    );
  }

  try {
    const redirectUri = `${publicOrigin(args.request)}/github/mobile-install/callback`;
    const token = await exchangeGithubUserCode({ code, redirectUri });
    if (!(await githubUserCanAccessInstallation(token, state.installationId))) {
      throw redirect(
        mobileGithubErrorUrl(state.redirectUrl, "verification_failed"),
      );
    }
    const handoff = await createMobileGithubHandoff({
      installationId: state.installationId,
      orgId: state.orgId,
      userId: state.userId,
      sessionId: state.sessionId,
    });
    throw redirect(mobileGithubHandoffUrl(handoff, state.redirectUrl));
  } catch (error) {
    if (error instanceof Response) throw error;
    throw redirect(
      mobileGithubErrorUrl(state.redirectUrl, "verification_failed"),
    );
  }
}

export function meta() {
  return [{ title: "GitHub authorization · eden" }, ...noindexMeta];
}

export default function MobileGithubCallback({
  loaderData,
}: Route.ComponentProps) {
  return (
    <main className="mx-auto max-w-lg px-6 py-16">
      <Alert variant="destructive">
        <AlertTitle>GitHub was not connected</AlertTitle>
        <AlertDescription>{loaderData.error}</AlertDescription>
      </Alert>
      <Button asChild className="mt-4">
        <Link to="/connect">Open Connect on the web</Link>
      </Button>
    </main>
  );
}
