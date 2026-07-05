/**
 * normalizeCatalog — the pure join of the two AI Gateway payloads that feeds the model picker.
 * Pins the rules that matter for correctness: only language models, tolerant of missing/extra
 * fields, pricing converted to per-1M numbers, providers joined by slug, sorted, descriptions
 * truncated. filterModels covers the picker's case-insensitive id+name search.
 */
import { describe, expect, it } from "vitest";

import { normalizeCatalog } from "~/models/catalog.server";
import { filterModels } from "~/components/model-select";

/** A minimal `/v1/models` payload; `extra` fields prove unknown keys pass through untouched. */
const rich = (models: unknown[]) => ({ data: models, extra: "ignored" });
/** A minimal `/v1/models/catalog` payload. */
const catalog = (models: unknown[]) => ({ models, providerAliases: {} });

describe("normalizeCatalog", () => {
  it("keeps only language models", () => {
    const out = normalizeCatalog(
      rich([
        { id: "a/lang", type: "language" },
        { id: "b/embed", type: "embedding" },
        { id: "c/image", type: "image" },
      ]),
      catalog([]),
    );
    expect(out.map((m) => m.id)).toEqual(["a/lang"]);
  });

  it("treats missing pricing and context_window as null", () => {
    const [m] = normalizeCatalog(
      rich([{ id: "a/model", type: "language" }]),
      catalog([]),
    );
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
      rich([
        {
          id: "zai/glm-5.2",
          type: "language",
          pricing: { input: "0.0000014", output: "0.0000044" },
        },
      ]),
      catalog([]),
    );
    expect(m.inputPerMTok).toBeCloseTo(1.4, 6);
    expect(m.outputPerMTok).toBeCloseTo(4.4, 6);
  });

  it("yields null for unparseable pricing", () => {
    const [m] = normalizeCatalog(
      rich([
        { id: "a/model", type: "language", pricing: { input: "abc", output: null } },
      ]),
      catalog([]),
    );
    expect(m.inputPerMTok).toBeNull();
    expect(m.outputPerMTok).toBeNull();
  });

  it("joins provider names by slug", () => {
    const [m] = normalizeCatalog(
      rich([{ id: "zai/glm-5.2", type: "language" }]),
      catalog([
        {
          slug: "zai/glm-5.2",
          providers: [
            { provider: "baseten", providerModelId: "zai-org/GLM-5.2" },
            { provider: "fireworks" },
          ],
        },
        { slug: "other/model", providers: [{ provider: "openai" }] },
      ]),
    );
    expect(m.providers).toEqual(["baseten", "fireworks"]);
  });

  it("tolerates unknown extra fields on every payload", () => {
    const out = normalizeCatalog(
      rich([
        {
          id: "a/model",
          type: "language",
          name: "A",
          someNewField: 123,
          pricing: { input: "0.000001", output: "0.000002", newPriceKey: "x" },
        },
      ]),
      catalog([{ slug: "a/model", providers: [{ provider: "p", futureKey: 1 }], extra: true }]),
    );
    expect(out).toHaveLength(1);
    expect(out[0].providers).toEqual(["p"]);
  });

  it("sorts by id", () => {
    const out = normalizeCatalog(
      rich([
        { id: "z/last", type: "language" },
        { id: "a/first", type: "language" },
        { id: "m/mid", type: "language" },
      ]),
      catalog([]),
    );
    expect(out.map((m) => m.id)).toEqual(["a/first", "m/mid", "z/last"]);
  });

  it("truncates long descriptions", () => {
    const long = "x".repeat(400);
    const [m] = normalizeCatalog(
      rich([{ id: "a/model", type: "language", description: long }]),
      catalog([]),
    );
    expect(m.description).not.toBeNull();
    expect(m.description!.length).toBeLessThanOrEqual(161); // 160 + ellipsis
    expect(m.description!.endsWith("…")).toBe(true);
  });

  it("falls back to id when name is absent", () => {
    const [m] = normalizeCatalog(
      rich([{ id: "a/model", type: "language" }]),
      catalog([]),
    );
    expect(m.name).toBe("a/model");
  });
});

describe("filterModels", () => {
  const model = (id: string, name: string): Parameters<typeof filterModels>[0][number] => ({
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
  const models = [
    model("anthropic/claude-opus-4-8", "Claude Opus 4.8"),
    model("openai/gpt-5.1", "GPT-5.1"),
    model("zai/glm-5.2", "GLM 5.2"),
  ];

  it("returns everything for an empty query", () => {
    expect(filterModels(models, "  ")).toHaveLength(3);
  });

  it("matches on id, case-insensitively", () => {
    expect(filterModels(models, "ZAI").map((m) => m.id)).toEqual(["zai/glm-5.2"]);
  });

  it("matches on name", () => {
    expect(filterModels(models, "opus").map((m) => m.id)).toEqual([
      "anthropic/claude-opus-4-8",
    ]);
  });

  it("returns nothing when no id or name matches", () => {
    expect(filterModels(models, "nomatch")).toEqual([]);
  });
});
