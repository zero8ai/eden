/**
 * The workspace model union (issue #28) — additive: active-Codex entries FIRST, then the OpenRouter
 * catalog. Pins entry shape/ordering, OpenRouter-failure degradation, and `findKnownModel`'s
 * codex-vs-OpenRouter resolution. The OpenRouter catalog is injected/mocked (no network).
 */
import { describe, expect, it, vi } from "vitest";

import type { ModelCatalogEntry } from "~/models/catalog.server";
import { CODEX_MODEL_SPECS } from "~/models/codex-catalog";
import type { ModelConnection } from "~/models/provider-connections.server";

const findModelMock = vi.fn<(id: string) => Promise<ModelCatalogEntry | null>>();

vi.mock("~/models/catalog.server", () => ({
  findModel: (id: string) => findModelMock(id),
  listOpenRouterModels: vi.fn(),
}));

import {
  codexCatalogEntries,
  findKnownModel,
  listWorkspaceModels,
} from "~/models/union.server";

function connection(overrides: Partial<ModelConnection> = {}): ModelConnection {
  return {
    id: "conn_1",
    provider: "codex",
    label: "Work Codex",
    accountEmail: "me@x.com",
    status: "active",
    createdAt: new Date(),
    ...overrides,
  };
}

function orModel(id: string): ModelCatalogEntry {
  return {
    id,
    name: id,
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    tags: [],
    inputPerMTok: null,
    outputPerMTok: null,
    providers: [],
  };
}

describe("codexCatalogEntries", () => {
  it("emits one entry per connection × curated slug with a codex-qualified id", () => {
    const entries = codexCatalogEntries([connection()]);
    expect(entries).toHaveLength(CODEX_MODEL_SPECS.length);
    const first = entries[0];
    expect(first.id).toBe(`codex/conn_1/${CODEX_MODEL_SPECS[0].slug}`);
    expect(first.name).toContain("Work Codex");
    expect(first.description).toContain("me@x.com");
    expect(first.tags).toEqual(["codex", "subscription"]);
    expect(first.providers).toEqual(["codex"]);
  });

  it("omits the email suffix when the connection has none", () => {
    const [entry] = codexCatalogEntries([connection({ accountEmail: null })]);
    expect(entry.description).toBe("OpenAI Codex subscription");
  });
});

describe("listWorkspaceModels", () => {
  it("lists codex entries first, then the OpenRouter catalog", async () => {
    const models = await listWorkspaceModels("org_1", {
      listCodexConnections: async () => [connection()],
      listOpenRouter: async () => [orModel("anthropic/claude-sonnet-5")],
    });
    expect(models).not.toBeNull();
    expect(models![0].id.startsWith("codex/")).toBe(true);
    expect(models![models!.length - 1].id).toBe("anthropic/claude-sonnet-5");
  });

  it("degrades to codex-only (with a warning) when OpenRouter throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const models = await listWorkspaceModels("org_1", {
      listCodexConnections: async () => [connection()],
      listOpenRouter: async () => {
        throw new Error("openrouter down");
      },
    });
    expect(models!.every((m) => m.id.startsWith("codex/"))).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("returns null when both are empty because OpenRouter threw (preserve free-text fallback)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const models = await listWorkspaceModels("org_1", {
      listCodexConnections: async () => [],
      listOpenRouter: async () => {
        throw new Error("openrouter down");
      },
    });
    expect(models).toBeNull();
    warn.mockRestore();
  });
});

describe("findKnownModel", () => {
  it("resolves a codex id from the curated spec without touching OpenRouter", async () => {
    findModelMock.mockClear();
    const entry = await findKnownModel(`codex/conn_1/${CODEX_MODEL_SPECS[0].slug}`);
    expect(entry?.name).toBe(CODEX_MODEL_SPECS[0].name);
    expect(entry?.contextWindow).toBe(CODEX_MODEL_SPECS[0].contextWindow);
    expect(findModelMock).not.toHaveBeenCalled();
  });

  it("falls through to the OpenRouter catalog for a non-codex id", async () => {
    findModelMock.mockResolvedValueOnce(orModel("z-ai/glm-5.2"));
    const entry = await findKnownModel("z-ai/glm-5.2");
    expect(entry?.id).toBe("z-ai/glm-5.2");
    expect(findModelMock).toHaveBeenCalledWith("z-ai/glm-5.2");
  });
});
