/**
 * normalizeCatalog — the pure OpenRouter model-list parser that feeds the model picker.
 * Pins the rules that matter for correctness: text-output models only, tolerant of
 * missing/extra fields, pricing converted to per-1M numbers, sorted, descriptions truncated.
 * filterModels covers the picker's case-insensitive id+name search.
 */
import { describe, expect, it } from "vitest";

import {
  normalizeCatalog,
  type ModelCatalogEntry,
} from "~/models/catalog.server";
import { filterModels, limitModelsPerConnection } from "~/models/filter";

/** A minimal OpenRouter `/api/v1/models` payload. */
const models = (data: unknown[]) => ({ data, extra: "ignored" });

describe("normalizeCatalog", () => {
  it("keeps text-output models and drops non-text models", () => {
    const out = normalizeCatalog(
      models([
        { id: "a/text", architecture: { output_modalities: ["text"] } },
        { id: "b/image", architecture: { output_modalities: ["image"] } },
        { id: "c/missing-architecture" },
      ]),
    );
    expect(out.map((m) => m.id)).toEqual(["a/text", "c/missing-architecture"]);
  });

  it("treats missing pricing and context metadata as null", () => {
    const [m] = normalizeCatalog(models([{ id: "a/model" }]));
    expect(m.contextWindow).toBeNull();
    expect(m.maxOutputTokens).toBeNull();
    expect(m.inputPerMTok).toBeNull();
    expect(m.outputPerMTok).toBeNull();
    expect(m.description).toBeNull();
    expect(m.tags).toEqual([]);
    expect(m.providers).toEqual([]);
  });

  it("converts pricing strings to USD per 1M tokens", () => {
    const [m] = normalizeCatalog(
      models([
        {
          id: "z-ai/glm-5.2",
          pricing: { prompt: "0.0000014", completion: "0.0000044" },
        },
      ]),
    );
    expect(m.inputPerMTok).toBeCloseTo(1.4, 6);
    expect(m.outputPerMTok).toBeCloseTo(4.4, 6);
  });

  it("yields null for unparseable pricing", () => {
    const [m] = normalizeCatalog(
      models([{ id: "a/model", pricing: { prompt: "abc", completion: null } }]),
    );
    expect(m.inputPerMTok).toBeNull();
    expect(m.outputPerMTok).toBeNull();
  });

  it("uses top provider metadata for max output tokens", () => {
    const [m] = normalizeCatalog(
      models([
        {
          id: "anthropic/claude-sonnet-5",
          context_length: 1_000_000,
          top_provider: { max_completion_tokens: 128_000 },
          supported_parameters: ["tools", "reasoning"],
        },
      ]),
    );
    expect(m.contextWindow).toBe(1_000_000);
    expect(m.maxOutputTokens).toBe(128_000);
    expect(m.tags).toEqual(["tools", "reasoning"]);
  });

  it("tolerates unknown extra fields on every payload", () => {
    const out = normalizeCatalog(
      models([
        {
          id: "a/model",
          name: "A",
          someNewField: 123,
          pricing: {
            prompt: "0.000001",
            completion: "0.000002",
            newPriceKey: "x",
          },
        },
      ]),
    );
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("A");
  });

  it("sorts by id", () => {
    const out = normalizeCatalog(
      models([{ id: "z/last" }, { id: "a/first" }, { id: "m/mid" }]),
    );
    expect(out.map((m) => m.id)).toEqual(["a/first", "m/mid", "z/last"]);
  });

  it("truncates long descriptions", () => {
    const long = "x".repeat(400);
    const [m] = normalizeCatalog(
      models([{ id: "a/model", description: long }]),
    );
    expect(m.description).not.toBeNull();
    expect(m.description!.length).toBeLessThanOrEqual(163); // 160 + "..."
    expect(m.description!.endsWith("...")).toBe(true);
  });

  it("falls back to id when name is absent", () => {
    const [m] = normalizeCatalog(models([{ id: "a/model" }]));
    expect(m.name).toBe("a/model");
  });
});

describe("filterModels", () => {
  const model = (id: string, name: string): ModelCatalogEntry => ({
    id,
    name,
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    tags: [],
    inputPerMTok: null,
    outputPerMTok: null,
    providers: [],
  });
  const catalog = [
    model("anthropic/claude-opus-4-8", "Claude Opus 4.8"),
    model("openai/gpt-5.1", "GPT-5.1"),
    model("z-ai/glm-5.2", "GLM 5.2"),
  ];

  it("returns everything for an empty query", () => {
    expect(filterModels(catalog, "  ")).toHaveLength(3);
  });

  it("matches on id, case-insensitively", () => {
    expect(filterModels(catalog, "Z-AI").map((m) => m.id)).toEqual([
      "z-ai/glm-5.2",
    ]);
  });

  it("matches on name", () => {
    expect(filterModels(catalog, "opus").map((m) => m.id)).toEqual([
      "anthropic/claude-opus-4-8",
    ]);
  });

  it("returns nothing when no id or name matches", () => {
    expect(filterModels(catalog, "nomatch")).toEqual([]);
  });
});

describe("limitModelsPerConnection", () => {
  it("keeps later provider and same-provider connection groups visible", () => {
    const first = Array.from({ length: 120 }, (_, index) => ({
      id: `openrouter/aaaaaaaaaaaa/vendor/model-${index}`,
      name: `Router ${index}`,
      provider: "openrouter",
      connectionId: "aaaaaaaaaaaa",
    }));
    const later = [
      {
        id: "anthropic/bbbbbbbbbbbb/claude",
        name: "Claude",
        provider: "anthropic",
        connectionId: "bbbbbbbbbbbb",
      },
      {
        id: "openrouter/cccccccccccc/vendor/other",
        name: "Other router",
        provider: "openrouter",
        connectionId: "cccccccccccc",
      },
    ];

    const visible = limitModelsPerConnection([...first, ...later], 50);
    expect(visible).toHaveLength(52);
    expect(visible).toEqual(expect.arrayContaining(later));
  });
});
