/**
 * The workspace model union (issue #28, Phase 1) — what every model picker shows.
 *
 * Phase 1 is ADDITIVE: a workspace's model list is the org's connected Codex-subscription models
 * (one `codex/<connectionId>/<slug>` entry per active connection × curated slug) FOLLOWED BY the
 * full OpenRouter catalog, which keeps working exactly as before. Codex entries come first so a
 * freshly-connected subscription is easy to find, but nothing about OpenRouter changes.
 *
 * `findKnownModel` resolves a single id back to its metadata for staging/attribution — a `codex/…`
 * id resolves from the curated spec (connection-agnostic: name + context window come from the
 * slug), everything else falls through to the OpenRouter catalog.
 */
import { findModel, listOpenRouterModels, type ModelCatalogEntry } from "~/models/catalog.server";
import {
  buildCodexModelId,
  findCodexSpec,
  parseCodexModelId,
  CODEX_MODEL_SPECS,
} from "~/models/codex-catalog";
import {
  listActiveCodexConnections,
  type ModelConnection,
} from "~/models/provider-connections.server";

/** Render the picker entries for the org's active Codex connections. */
export function codexCatalogEntries(
  connections: ModelConnection[],
): ModelCatalogEntry[] {
  const entries: ModelCatalogEntry[] = [];
  for (const conn of connections) {
    for (const spec of CODEX_MODEL_SPECS) {
      entries.push({
        id: buildCodexModelId(conn.id, spec.slug),
        name: `${spec.name} · ${conn.label}`,
        description:
          "OpenAI Codex subscription" +
          (conn.accountEmail ? ` (${conn.accountEmail})` : ""),
        contextWindow: spec.contextWindow,
        maxOutputTokens: null,
        tags: ["codex", "subscription"],
        inputPerMTok: null,
        outputPerMTok: null,
        providers: ["codex"],
      });
    }
  }
  return entries;
}

/** A single curated Codex entry from an id — for `findKnownModel` (connection-agnostic). */
function codexEntryFromId(id: string): ModelCatalogEntry | null {
  const parsed = parseCodexModelId(id);
  if (!parsed) return null;
  const spec = findCodexSpec(parsed.slug);
  return {
    id,
    name: spec?.name ?? parsed.slug,
    description: "OpenAI Codex subscription",
    contextWindow: spec?.contextWindow ?? null,
    maxOutputTokens: null,
    tags: ["codex", "subscription"],
    inputPerMTok: null,
    outputPerMTok: null,
    providers: ["codex"],
  };
}

/** Injected accessors so the union unit-tests with no DB / no network. */
export interface WorkspaceModelDeps {
  listCodexConnections: typeof listActiveCodexConnections;
  listOpenRouter: typeof listOpenRouterModels;
}

/**
 * The full picker union for a workspace: active-Codex entries first, then the OpenRouter catalog.
 * An OpenRouter failure degrades to codex-only (with a warning); when BOTH are empty because
 * OpenRouter threw, returns null so the picker keeps its free-text fallback (as api.models does
 * today).
 */
export async function listWorkspaceModels(
  orgId: string,
  deps: WorkspaceModelDeps = {
    listCodexConnections: listActiveCodexConnections,
    listOpenRouter: listOpenRouterModels,
  },
): Promise<ModelCatalogEntry[] | null> {
  const connections = await deps.listCodexConnections(orgId).catch(() => []);
  const codex = codexCatalogEntries(connections);
  try {
    const openrouter = await deps.listOpenRouter();
    return [...codex, ...openrouter];
  } catch (error) {
    console.warn("[models.union] OpenRouter catalog unavailable:", error);
    return codex.length > 0 ? codex : null;
  }
}

/** Resolve one model id to its metadata — codex spec first, else the OpenRouter catalog. */
export async function findKnownModel(
  id: string,
): Promise<ModelCatalogEntry | null> {
  return codexEntryFromId(id) ?? (await findModel(id));
}
