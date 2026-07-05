/**
 * The Vercel AI Gateway model catalog — the source of truth for the model picker.
 *
 * Agent model ids in this product are AI GATEWAY slugs (ai-gateway.vercel.sh), NOT the
 * spellings you might know from a provider's own site or from OpenRouter. eve compiles each
 * agent against the gateway's catalog to resolve context-window metadata, so an id the gateway
 * doesn't know publishes to a hard failure ("does not have known AI Gateway context window
 * metadata"). The dogfooding bug that motivated this file: someone staged `z-ai/glm-5.2`
 * (OpenRouter's spelling) when the gateway slug is `zai/glm-5.2` — a one-character difference
 * that only surfaced at publish time. Feeding the picker from the live catalog (and validating
 * ids on the way in) makes that class of mistake unstageable.
 *
 * Two public gateway endpoints, joined by slug:
 *  - /v1/models          — the rich per-model card (name, description, pricing, context window).
 *  - /v1/models/catalog  — the provider fan-out (which providers serve each slug).
 * Both are public and unauthenticated. Every field except the id is optional/absent on some
 * models, so parsing is loose (zod `.passthrough()`, everything optional) — a new field the
 * gateway adds must never break the picker. `normalizeCatalog` is a PURE join of the two
 * payloads so it's unit-testable without a fetch; `listGatewayModels` wraps it in the shared
 * SwrCache (one network round-trip serves the whole catalog for an hour).
 */
import { z } from "zod";

import { SwrCache } from "~/github/cache.server";

const MODELS_URL = "https://ai-gateway.vercel.sh/v1/models";
const CATALOG_URL = "https://ai-gateway.vercel.sh/v1/models/catalog";
const CACHE_KEY = "gateway:models";
const TTL_MS = 60 * 60 * 1000; // 1 hour — the catalog changes on the order of days.
const DESCRIPTION_MAX = 160;

/** One model as the picker consumes it — flat, numbers pre-computed, providers pre-joined. */
export interface GatewayModel {
  id: string;
  name: string;
  description: string | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  tags: string[];
  /** USD per 1M input tokens (the gateway reports per-single-token strings). */
  inputPerMTok: number | null;
  /** USD per 1M output tokens. */
  outputPerMTok: number | null;
  /** Provider names serving this slug, from the catalog payload. */
  providers: string[];
}

// Loose schemas: unknown extra fields pass through untouched, and every field but the join
// key is optional — the gateway's shape is theirs to evolve, not ours to gate on.
const richModelSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    description: z.string().nullish(),
    context_window: z.number().nullish(),
    max_tokens: z.number().nullish(),
    type: z.string().optional(),
    tags: z.array(z.string()).optional(),
    pricing: z
      .object({ input: z.string().nullish(), output: z.string().nullish() })
      .passthrough()
      .nullish(),
  })
  .passthrough();

const richSchema = z.object({ data: z.array(richModelSchema) }).passthrough();

const catalogEntrySchema = z
  .object({
    slug: z.string(),
    providers: z
      .array(z.object({ provider: z.string() }).passthrough())
      .optional(),
  })
  .passthrough();

const catalogSchema = z
  .object({ models: z.array(catalogEntrySchema) })
  .passthrough();

/** USD-per-single-token string → USD per 1M tokens, or null when absent/unparseable. */
function perMTok(price: string | null | undefined): number | null {
  if (price == null) return null;
  const n = Number(price);
  return Number.isFinite(n) ? n * 1_000_000 : null;
}

/**
 * Join the two gateway payloads into the flat picker shape. Pure — no fetch, no cache — so the
 * parsing/filtering/pricing rules are exercised directly in tests. Keeps only `type` ===
 * "language", truncates descriptions, converts pricing to per-1M numbers, attaches provider
 * names by slug, and sorts by id for a stable list.
 */
export function normalizeCatalog(rich: unknown, catalog: unknown): GatewayModel[] {
  const richParsed = richSchema.parse(rich);
  const catalogParsed = catalogSchema.parse(catalog);

  const providersBySlug = new Map<string, string[]>();
  for (const entry of catalogParsed.models) {
    providersBySlug.set(
      entry.slug,
      (entry.providers ?? []).map((p) => p.provider),
    );
  }

  return richParsed.data
    .filter((m) => m.type === "language")
    .map((m): GatewayModel => {
      const description = m.description ?? null;
      return {
        id: m.id,
        name: m.name ?? m.id,
        description:
          description && description.length > DESCRIPTION_MAX
            ? `${description.slice(0, DESCRIPTION_MAX).trimEnd()}…`
            : description,
        contextWindow: m.context_window ?? null,
        maxOutputTokens: m.max_tokens ?? null,
        tags: m.tags ?? [],
        inputPerMTok: perMTok(m.pricing?.input),
        outputPerMTok: perMTok(m.pricing?.output),
        providers: providersBySlug.get(m.id) ?? [],
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

const globalForCache = globalThis as unknown as {
  __edenModelCatalogCache?: SwrCache;
};

// A dedicated SwrCache instance stashed on globalThis to survive dev HMR (same pattern as
// githubCache). Separate from the GitHub cache so their keyspaces and lifecycles never mix.
const catalogCache: SwrCache =
  globalForCache.__edenModelCatalogCache ?? new SwrCache();

if (process.env.NODE_ENV !== "production") {
  globalForCache.__edenModelCatalogCache = catalogCache;
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`gateway ${url} → ${res.status} ${res.statusText}`);
  }
  return res.json();
}

/**
 * The full picker catalog, SWR-cached for an hour. Both endpoints are fetched in parallel and
 * joined. Fetch/parse errors propagate — callers decide how to degrade (the resource route
 * returns `{ models: null }`; `isKnownModel` fails open).
 */
export function listGatewayModels(): Promise<GatewayModel[]> {
  return catalogCache.get(CACHE_KEY, TTL_MS, async () => {
    const [rich, catalog] = await Promise.all([
      fetchJson(MODELS_URL),
      fetchJson(CATALOG_URL),
    ]);
    return normalizeCatalog(rich, catalog);
  });
}

/**
 * Whether `id` is a known gateway model. Returns null when the catalog can't be loaded — a
 * fail-open signal so a transient gateway outage never blocks a legitimate edit; callers treat
 * null as "skip validation".
 */
export async function isKnownModel(id: string): Promise<boolean | null> {
  try {
    const models = await listGatewayModels();
    return models.some((m) => m.id === id);
  } catch {
    return null;
  }
}
