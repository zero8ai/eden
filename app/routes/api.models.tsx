/**
 * Resource route feeding the searchable model picker (ModelSelect). Returns the workspace model
 * union — the org's connected Codex-subscription models FIRST, then the live OpenRouter catalog
 * (issue #28, Phase 1; additive — OpenRouter is untouched).
 *
 * Lazily loaded — the settings page doesn't pay for the catalog until the picker opens (one
 * `useFetcher` fires on first open). A catalog hiccup must never 500 the picker, so a failed
 * fetch degrades to `{ models: null }` and the UI falls back to a free-text field. Auth-gated
 * like the other api routes (`ensureSignedIn`); when the caller has no active workspace we fall
 * back to the OpenRouter-only catalog as before.
 */
import { sessionLoader } from "~/auth/session.server";
import type { LoaderFunctionArgs } from "react-router";

import { resolveActiveWorkspace } from "~/auth/workspace.server";
import {
  listOpenRouterModels,
  type ModelCatalogEntry,
} from "~/models/catalog.server";
import { listWorkspaceModels } from "~/models/union.server";

export const loader = (args: LoaderFunctionArgs) =>
  sessionLoader(
    args,
    async ({ auth }): Promise<{ models: ModelCatalogEntry[] | null }> => {
      try {
        const active = await resolveActiveWorkspace(auth);
        if (active?.org) {
          return { models: await listWorkspaceModels(active.org.id) };
        }
        return { models: await listOpenRouterModels() };
      } catch (error) {
        console.warn("[api.models] model catalog unavailable:", error);
        return { models: null };
      }
    },
    { ensureSignedIn: true },
  );
