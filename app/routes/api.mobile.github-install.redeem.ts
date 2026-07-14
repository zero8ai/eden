import { getSessionAuth } from "~/auth/session.server";
import { resolveActiveWorkspace } from "~/auth/workspace.server";
import { consumeMobileGithubHandoff } from "~/github/mobile-install.server";
import { rememberInstallation } from "~/github/installations.server";
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
  const handoff = String(form.get("handoff") ?? "");
  if (!handoff) {
    return data(
      {
        error: "missing_handoff",
        message: "GitHub did not return an installation handoff.",
      },
      { status: 400 },
    );
  }
  const installationId = await consumeMobileGithubHandoff({
    code: handoff,
    orgId: active.org.id,
    userId: auth.user.id,
    sessionId: auth.session.id,
  });
  if (!installationId) {
    return data(
      {
        error: "invalid_handoff",
        message:
          "This GitHub handoff is invalid, expired, or belongs to another session.",
      },
      { status: 403 },
    );
  }
  await rememberInstallation(active.org.id, installationId);
  return { ok: true as const };
}
