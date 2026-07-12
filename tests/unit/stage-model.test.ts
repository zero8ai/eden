/**
 * Model staging shared by Settings' "Model" section and the Playground's "Enable model
 * switching" — against the in-memory store with GitHub and the model catalog stubbed. Pins the
 * migration contract: `agent.ts` gets the dynamic wrapper (per-conversation directives work),
 * the upgrade path keeps the CURRENT model and context window (no model change), package.json
 * is normalized alongside, and re-running stages identical content (idempotent).
 */
import { beforeEach, describe, expect, it } from "vitest";

import { getDraft } from "~/drafts/drafts.server";
import { hasDynamicModel, readModel } from "~/eve/agentModule";
import {
  stageModelChange,
  stageModelSwitchingUpgrade,
  type StageModelDeps,
} from "~/models/stage-model.server";
import { makeFakeStore, type FakeStore } from "../fakes/store";

const PROJECT = {
  id: "proj_1",
  orgId: "org_1",
  repoInstallationId: "inst_1",
  repoOwner: "acme",
  repoName: "agent",
};

/** A pre-wrapper module, as shipped by older catalog templates — ignores model directives. */
const STATIC_AGENT_TS = `import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { defineAgent } from "eve";

const openrouter = createOpenAICompatible({
  name: "openrouter",
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY ?? "",
});

export default defineAgent({
  model: openrouter.chatModel("z-ai/glm-5.2"),
  modelContextWindowTokens: 1000000,
});
`;

const PKG =
  JSON.stringify({ dependencies: { eve: "^0.20.0", zod: "^4.4.3" } }, null, 2) +
  "\n";

/** Repo reads and the catalog lookup, keyed by path — no GitHub, no network. */
function fakeDeps(files: Record<string, string>): StageModelDeps {
  return {
    readFile: async (_installationId, _repo, path) => files[path] ?? null,
    findOpenChange: async () => null,
    lookupModel: async (_orgId, model) =>
      model.startsWith("openrouter/") || model.startsWith("openai/")
        ? {
            id: model,
            name: model,
            description: null,
            contextWindow: null,
            maxOutputTokens: null,
            tags: [],
            inputPerMTok: null,
            outputPerMTok: null,
            providers: [],
            upstreamModelId: model.split("/").slice(2).join("/"),
            provider: model.startsWith("openai/") ? "openai" : "openrouter",
            providerName: model.startsWith("openai/")
              ? "OpenAI Platform"
              : "OpenRouter",
            connectionId: "abcdefghijkl",
            connectionLabel: "Test",
          }
        : null,
  };
}

let store: FakeStore;

beforeEach(() => {
  store = makeFakeStore();
  store.seedProject({ id: PROJECT.id, orgId: "org_1" });
  store.seedAgent({ id: "agent_1", projectId: PROJECT.id });
});

describe("stageModelChange", () => {
  it("stages agent.ts with the dynamic wrapper and the package.json dependency bumps", async () => {
    const result = await stageModelChange(
      {
        project: PROJECT,
        root: "agent",
        model: "openai/abcdefghijkl/gpt-5.1",
        createdBy: "user_1",
      },
      store,
      fakeDeps({ "agent/agent.ts": STATIC_AGENT_TS, "package.json": PKG }),
    );

    expect(result).toEqual({ ok: true });
    const agentDraft = await getDraft(PROJECT.id, "agent/agent.ts", store);
    expect(hasDynamicModel(agentDraft?.content)).toBe(true);
    expect(readModel(agentDraft!.content!)).toBe("openai/abcdefghijkl/gpt-5.1");
    const pkg = JSON.parse(
      (await getDraft(PROJECT.id, "package.json", store))!.content!,
    ) as { dependencies: Record<string, string> };
    expect(pkg.dependencies["@ai-sdk/anthropic"]).toBe("^4.0.12");
    expect(pkg.dependencies["@ai-sdk/openai"]).toBe("^4.0.11");
    expect(pkg.dependencies["@ai-sdk/openai-compatible"]).toBe("^3.0.7");
    expect(pkg.dependencies.eve).toBe("^0.22.0"); // < 0.22 can't provide defineDynamic
  });

  it("reports invalid package.json instead of staging half a change", async () => {
    const result = await stageModelChange(
      {
        project: PROJECT,
        root: "agent",
        model: "openai/abcdefghijkl/gpt-5.1",
        createdBy: null,
      },
      store,
      fakeDeps({ "agent/agent.ts": STATIC_AGENT_TS, "package.json": "{ nope" }),
    );

    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining("not valid JSON"),
    });
    expect(await getDraft(PROJECT.id, "agent/agent.ts", store)).toBeNull();
  });

  it("rejects a model that is not owned by an active workspace connection", async () => {
    const deps = fakeDeps({
      "agent/agent.ts": STATIC_AGENT_TS,
      "package.json": PKG,
    });
    deps.lookupModel = async () => null;
    const result = await stageModelChange(
      {
        project: PROJECT,
        root: "agent",
        model: "openai/zzzzzzzzzzzz/gpt-5.1",
        createdBy: "user_1",
      },
      store,
      deps,
    );

    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining("active provider connection"),
    });
    expect(await getDraft(PROJECT.id, "agent/agent.ts", store)).toBeNull();
  });
});

describe("stageModelSwitchingUpgrade", () => {
  it("wraps the CURRENT model — no model or context-window change", async () => {
    const result = await stageModelSwitchingUpgrade(
      { project: PROJECT, root: "agent", createdBy: "user_1" },
      store,
      fakeDeps({ "agent/agent.ts": STATIC_AGENT_TS, "package.json": PKG }),
    );

    expect(result).toEqual({ ok: true });
    const draft = await getDraft(PROJECT.id, "agent/agent.ts", store);
    expect(hasDynamicModel(draft?.content)).toBe(true);
    expect(readModel(draft!.content!)).toBe("z-ai/glm-5.2");
    // The catalog lookup missed (stubbed to null) — the module's declared window survives.
    expect(draft!.content!).toContain("modelContextWindowTokens: 1000000");
  });

  it("is idempotent — a second run re-stages identical content", async () => {
    const deps = fakeDeps({
      "agent/agent.ts": STATIC_AGENT_TS,
      "package.json": PKG,
    });
    const input = { project: PROJECT, root: "agent", createdBy: null };

    await stageModelSwitchingUpgrade(input, store, deps);
    const first = await getDraft(PROJECT.id, "agent/agent.ts", store);
    const firstPkg = await getDraft(PROJECT.id, "package.json", store);

    // The second run reads the FIRST run's drafts (draft-first file view) and must not churn.
    await stageModelSwitchingUpgrade(input, store, deps);
    const second = await getDraft(PROJECT.id, "agent/agent.ts", store);
    const secondPkg = await getDraft(PROJECT.id, "package.json", store);

    expect(second?.content).toBe(first?.content);
    expect(secondPkg?.content).toBe(firstPkg?.content);
    expect(readModel(second!.content!)).toBe("z-ai/glm-5.2");
  });

  it("errors when there is no agent.ts to read the current model from", async () => {
    const result = await stageModelSwitchingUpgrade(
      { project: PROJECT, root: "agent", createdBy: null },
      store,
      fakeDeps({ "package.json": PKG }),
    );

    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining("Settings"),
    });
    expect(await getDraft(PROJECT.id, "agent/agent.ts", store)).toBeNull();
  });
});
