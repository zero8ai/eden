/**
 * Resource route behind the shell's workspace menu (issue #56). Returns the user's workspaces
 * (from Better Auth organizations) and which one is active, so the header switcher can self-fetch
 * without threading the list through every page loader — the same pattern as the staged-changes
 * pill. No HTML; JSON only.
 */
import type { LoaderFunctionArgs } from "react-router";

import { sessionLoader } from "~/auth/session.server";
import { listUserWorkspaces } from "~/auth/workspace.server";

export const loader = (args: LoaderFunctionArgs) =>
  sessionLoader(
    args,
    async ({ auth }) => {
      const workspaces = await listUserWorkspaces(auth);
      const current = workspaces.find((w) => w.id === auth.organizationId);
      return {
        currentOrgId: auth.organizationId,
        currentName: current?.name ?? null,
        workspaces,
      };
    },
    { ensureSignedIn: true },
  );
