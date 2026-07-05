/**
 * Resource route feeding the searchable model picker (ModelSelect). Returns the live
 * OpenRouter catalog so the picker can search across every known model id + pricing/context.
 *
 * Lazily loaded — the settings page doesn't pay for the catalog until the picker opens (one
 * `useFetcher` fires on first open). A catalog hiccup must never 500 the picker, so a failed
 * fetch degrades to `{ models: null }` and the UI falls back to a free-text field. Auth-gated
 * like the other api routes (`ensureSignedIn`) — no project scope, the catalog is global.
 */
import { authkitLoader } from "@workos-inc/authkit-react-router";
import type { LoaderFunctionArgs } from "react-router";

import {
  listOpenRouterModels,
  type ModelCatalogEntry,
} from "~/models/catalog.server";

export const loader = (args: LoaderFunctionArgs) =>
  authkitLoader(
    args,
    async (): Promise<{ models: ModelCatalogEntry[] | null }> => {
      try {
        return { models: await listOpenRouterModels() };
      } catch (error) {
        console.warn("[api.models] model catalog unavailable:", error);
        return { models: null };
      }
    },
    { ensureSignedIn: true },
  );
