import { getSessionAuth } from "~/auth/session.server";
import { resolveActiveWorkspace } from "~/auth/workspace.server";
import { createOAuthStateNonce } from "~/connections/oauth-state.server";
import { getInstallUrl } from "~/github/client.server";
import {
  MOBILE_GITHUB_STATE_TTL_MS,
  signMobileGithubState,
  validateMobileGithubRedirectUrl,
} from "~/github/mobile-install.server";
import { data, type ActionFunctionArgs } from "react-router";

export async function action(args: ActionFunctionArgs) {
  const auth = await getSessionAuth(args);
  if (!auth.user) {
    return data(
      { error: "unauthorized", message: "Please sign in again." },
      { status: 401 },
    );
  }
  const active = await resolveActiveWorkspace(auth);
  if (!active) {
    return data(
      {
        error: "no_workspace",
        message: "Choose a workspace before connecting GitHub.",
      },
      { status: 409 },
    );
  }
  const form = await args.request.formData();
  const redirectUrl = validateMobileGithubRedirectUrl(
    String(form.get("redirectUrl") ?? ""),
  );
  if (!redirectUrl) {
    return data(
      {
        error: "invalid_redirect",
        message: "That native callback URL is not allowed.",
      },
      { status: 400 },
    );
  }

  const exp = Date.now() + MOBILE_GITHUB_STATE_TTL_MS;
  const nonce = await createOAuthStateNonce({
    userId: auth.user.id,
    sessionId: auth.session.id,
    expiresAt: new Date(exp),
  });
  const state = signMobileGithubState({
    provider: "github-mobile-install",
    phase: "setup",
    orgId: active.org.id,
    userId: auth.user.id,
    sessionId: auth.session.id,
    nonce,
    redirectUrl,
    exp,
  });
  return { authUrl: getInstallUrl(state), redirectUrl };
}
