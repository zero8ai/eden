/** Active workspace's connected-provider model union for every ModelSelect surface. */
import { sessionLoader } from "~/auth/session.server";
import type { LoaderFunctionArgs } from "react-router";

import { resolveActiveWorkspace } from "~/auth/workspace.server";
import type { ModelsApiResponse } from "~/components/model-select";
import { listWorkspaceModelCatalog } from "~/models/union.server";

export const loader = (args: LoaderFunctionArgs) =>
  sessionLoader(
    args,
    async ({ auth }): Promise<ModelsApiResponse> => {
      const active = await resolveActiveWorkspace(auth);
      if (!active?.org) return { models: [], unavailable: [] };

      try {
        return await listWorkspaceModelCatalog(active.org.id);
      } catch (error) {
        console.warn("[api.models] model catalog unavailable:", error);
        return {
          models: [],
          unavailable: [
            {
              connectionId: "workspace",
              provider: "unknown",
              connectionLabel: "workspace model providers",
              message:
                error instanceof Error ? error.message : "Catalog unavailable",
            },
          ],
        };
      }
    },
    { ensureSignedIn: true },
  );
