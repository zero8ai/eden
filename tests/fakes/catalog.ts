/**
 * In-memory CatalogSource for unit tests — the fake behind the marketplace seam
 * (app/seams/types.ts). Lets loaders and the browse UI be tested with zero fs/network: hand it
 * a list of CatalogTemplates and it serves a matching index + per-template reads, deriving the
 * index rows from each template's manifest (hash left to the caller — the seam doesn't hash).
 */
import { type CatalogIndex } from "~/marketplace/manifest";
import type { CatalogSource, CatalogTemplate } from "~/seams/types";

/** A CatalogSource backed by an in-memory template list. Unknown ids throw, like the real impls. */
export function fakeCatalog(
  templates: CatalogTemplate[],
  opts: { hashOf?: (t: CatalogTemplate) => string } = {},
): CatalogSource {
  const hashOf = opts.hashOf ?? (() => "0");
  return {
    name: "fake",
    async index(): Promise<CatalogIndex> {
      return {
        templates: templates.map((t) => ({
          id: t.manifest.id,
          type: t.manifest.type,
          name: t.manifest.name,
          version: t.manifest.version,
          description: t.manifest.description,
          hash: hashOf(t),
        })),
      };
    },
    async template(type, id): Promise<CatalogTemplate> {
      const found = templates.find(
        (t) => t.manifest.type === type && t.manifest.id === id,
      );
      if (!found) {
        throw new Error(`No template ${type}/${id} in the fake catalog.`);
      }
      return found;
    },
  };
}
