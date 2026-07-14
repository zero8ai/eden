import { getSessionAuth } from "~/auth/session.server";
import { resolveActiveWorkspace } from "~/auth/workspace.server";
import {
  listKnownInstallations,
  resolveInstallationGrant,
} from "~/github/installations.server";
import { nativeAction } from "~/lib/mobile-resource.server";
import {
  data,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { action as webAction, loader as webLoader } from "./connect";

export async function loader(args: LoaderFunctionArgs) {
  const requestUrl = new URL(args.request.url);
  if (
    requestUrl.searchParams.has("installation_id") ||
    requestUrl.searchParams.has("state")
  ) {
    return data(
      {
        error: "invalid_installation_callback",
        message:
          "Complete GitHub authorization through Eden's secure mobile flow.",
      },
      { status: 400 },
    );
  }
  const result = await webLoader(args);
  if (result instanceof Response || result.github.state !== "pick")
    return result;
  const { installationId: privateInstallationId, ...safeGithub } =
    result.github;

  const auth = await getSessionAuth(args);
  if (!auth.user) return result;
  const active = await resolveActiveWorkspace(auth);
  if (!active) return result;
  const grants = await listKnownInstallations(active.org.id);
  const grant = grants.find(
    (candidate) => candidate.installationId === privateInstallationId,
  );
  if (!grant) {
    return {
      ...result,
      github: {
        state: "unconfigured" as const,
        message:
          "That GitHub installation is not authorized for this workspace.",
      },
    };
  }
  return {
    ...result,
    github: { ...safeGithub, installationGrantId: grant.id },
  };
}

async function authorizedMobileAction(args: ActionFunctionArgs) {
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
  const submitted = await args.request.formData();
  const grantId = String(submitted.get("installationGrantId") ?? "");
  const grant = grantId
    ? await resolveInstallationGrant(active.org.id, grantId)
    : null;
  if (!grant) {
    return data(
      {
        error: "invalid_installation_grant",
        message:
          "That GitHub installation is not authorized for this workspace.",
      },
      { status: 403 },
    );
  }

  // The shared web action remains unchanged for browser forms. Native callers can supply only an
  // opaque tenant-scoped grant; inject the private GitHub id into the server-side request copy.
  submitted.delete("installationGrantId");
  submitted.set("installationId", grant.installationId);
  const headers = new Headers(args.request.headers);
  // FormData creates a fresh multipart boundary. Reusing the caller's Content-Type would leave the
  // web action unable to parse this reconstructed body (and Content-Length is now stale too).
  headers.delete("content-type");
  headers.delete("content-length");
  const request = new Request(args.request.url, {
    method: "POST",
    headers,
    body: submitted,
  });
  return webAction({ ...args, request });
}

export const action = nativeAction(authorizedMobileAction);
