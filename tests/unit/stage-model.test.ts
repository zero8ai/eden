/**
 * Model staging shared by Settings' "Model" section and the Playground's "Enable model
 * switching" — against the in-memory store with GitHub and the model catalog stubbed. Pins the
 * migration contract: `agent.ts` gets the dynamic wrapper (per-conversation directives work),
 * the upgrade path keeps the CURRENT model and context window (no model change), package.json
 * is normalized alongside, and re-running stages identical content (idempotent).
 */
import { beforeEach, describe, expect, it } from "vitest";

import { getDraft, listDrafts, stageDraft } from "~/drafts/drafts.server";
import { hasDynamicModel, readModel } from "~/eve/agentModule";
import {
  stageModelChange,
  stageModelSwitchingUpgrade,
  stageSubagentModelWiring,
  type StageModelDeps,
  type SubagentWiringDeps,
} from "~/models/stage-model.server";
import type { WorkspaceModelCatalog } from "~/models/union.server";
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

/**
 * Repo reads and the catalog lookups, keyed by path — no GitHub, no network. The default
 * workspace catalog marks OpenRouter's listing unavailable, so the subagent wiring fails open to
 * the alias (the bare-literal wiring) unless a test supplies a concrete catalog.
 */
function fakeDeps(
  files: Record<string, string>,
  catalog?: WorkspaceModelCatalog,
): StageModelDeps & SubagentWiringDeps {
  return {
    loadCatalog: async () =>
      catalog ?? {
        models: [],
        unavailable: [
          {
            connectionId: "abcdefghijkl",
            provider: "openrouter",
            connectionLabel: "OpenRouter",
            message: "The provider catalog is unavailable.",
          },
        ],
      },
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

describe("stageSubagentModelWiring", () => {
  /** A subagent pinning a bare gateway-bound literal — the shape the wiring exists to fix. */
  const BARE_SUBAGENT = `import { defineAgent } from "eve";
export default defineAgent({
  description: "Read-only invoice airlock.",
  model: "anthropic/claude-sonnet-5",
});
`;

  /** A workspace whose only active connection is Anthropic and carries the subagent's model. */
  const ANTHROPIC_ONLY_CATALOG: WorkspaceModelCatalog = {
    models: [
      {
        id: "anthropic/mnopqrstuvwx/claude-sonnet-5",
        name: "Claude Sonnet 5",
        description: null,
        contextWindow: 200_000,
        maxOutputTokens: null,
        tags: [],
        inputPerMTok: null,
        outputPerMTok: null,
        providers: ["anthropic"],
        provider: "anthropic",
        providerName: "Anthropic",
        connectionId: "mnopqrstuvwx",
        connectionLabel: "Anthropic",
        upstreamModelId: "claude-sonnet-5",
      },
    ],
    unavailable: [],
  };

  it("stages a dynamic-wrapper rewrite for a gateway-bound repo subagent", async () => {
    const path = "agent/subagents/reader/agent.ts";
    const { wired, unresolved } = await stageSubagentModelWiring(
      {
        project: PROJECT,
        memberRoot: "agent",
        candidatePaths: [path, "agent/agent.ts", "agent/instructions.md"],
        createdBy: "user_1",
      },
      store,
      fakeDeps({ [path]: BARE_SUBAGENT }),
    );

    expect(wired).toEqual([path]);
    expect(unresolved).toEqual([]);
    const draft = await getDraft(PROJECT.id, path, store);
    expect(hasDynamicModel(draft?.content)).toBe(true);
    expect(readModel(draft!.content!)).toBe("anthropic/claude-sonnet-5");
  });

  it("qualifies the bare id against the workspace catalog (runs on the exact connection)", async () => {
    const path = "agent/subagents/reader/agent.ts";
    const { wired, unresolved } = await stageSubagentModelWiring(
      {
        project: PROJECT,
        memberRoot: "agent",
        candidatePaths: [path],
        createdBy: "user_1",
      },
      store,
      fakeDeps({ [path]: BARE_SUBAGENT }, ANTHROPIC_ONLY_CATALOG),
    );

    expect(wired).toEqual([path]);
    expect(unresolved).toEqual([]);
    const draft = await getDraft(PROJECT.id, path, store);
    expect(hasDynamicModel(draft?.content)).toBe(true);
    // The qualified ref resolves through the Anthropic connection's own credential — not the
    // OpenRouter alias, which doesn't exist on an Anthropic-only workspace.
    expect(readModel(draft!.content!)).toBe(
      "anthropic/mnopqrstuvwx/claude-sonnet-5",
    );
    expect(draft!.content!).toContain("modelContextWindowTokens: 200000");
  });

  it("stages nothing and reports the subagent when no active connection offers its model", async () => {
    const path = "agent/subagents/reader/agent.ts";
    const { wired, unresolved } = await stageSubagentModelWiring(
      {
        project: PROJECT,
        memberRoot: "agent",
        candidatePaths: [path],
        createdBy: "user_1",
      },
      store,
      fakeDeps({ [path]: BARE_SUBAGENT }, { models: [], unavailable: [] }),
    );

    expect(wired).toEqual([]);
    expect(unresolved).toEqual([
      { path, model: "anthropic/claude-sonnet-5", reason: "no-connection" },
    ]);
    // Left bare on purpose — the publish gate keeps blocking it, and the caller surfaces the
    // save-time hint instead of a runtime credential failure.
    expect(await getDraft(PROJECT.id, path, store)).toBeNull();
  });

  it("falls open to the alias wiring when the catalog loader fails", async () => {
    const path = "agent/subagents/reader/agent.ts";
    const deps = {
      ...fakeDeps({ [path]: BARE_SUBAGENT }),
      loadCatalog: async () => {
        throw new Error("catalog outage");
      },
    };
    const { wired, unresolved } = await stageSubagentModelWiring(
      {
        project: PROJECT,
        memberRoot: "agent",
        candidatePaths: [path],
        createdBy: "user_1",
      },
      store,
      deps,
    );

    expect(wired).toEqual([path]);
    expect(unresolved).toEqual([]);
    const draft = await getDraft(PROJECT.id, path, store);
    expect(readModel(draft!.content!)).toBe("anthropic/claude-sonnet-5");
  });

  it("wires a subagent that exists only as a staged draft (not yet in the repo)", async () => {
    const path = "agent/subagents/reader/agent.ts";
    await stageDraft(
      { projectId: PROJECT.id, path, content: BARE_SUBAGENT },
      store,
    );

    const { wired } = await stageSubagentModelWiring(
      {
        project: PROJECT,
        // The repo has never seen the subagent — only the draft knows the path.
        memberRoot: "agent",
        candidatePaths: ["agent/agent.ts"],
        createdBy: "user_1",
      },
      store,
      fakeDeps({}),
    );

    expect(wired).toEqual([path]);
    const draft = await getDraft(PROJECT.id, path, store);
    expect(hasDynamicModel(draft?.content)).toBe(true);
    expect(readModel(draft!.content!)).toBe("anthropic/claude-sonnet-5");
  });

  it("never un-deletes a subagent staged for deletion", async () => {
    const path = "agent/subagents/reader/agent.ts";
    await stageDraft({ projectId: PROJECT.id, path, content: null }, store);

    const { wired } = await stageSubagentModelWiring(
      {
        project: PROJECT,
        memberRoot: "agent",
        // The path is still in the repo (with the bad model) — the deletion must win anyway.
        candidatePaths: [path],
        createdBy: null,
      },
      store,
      fakeDeps({ [path]: BARE_SUBAGENT }),
    );

    expect(wired).toEqual([]);
    const draft = await getDraft(PROJECT.id, path, store);
    expect(draft?.content).toBeNull(); // still a deletion draft
  });

  it("is a no-op for already-wired subagents and other members' paths", async () => {
    const otherMembers = "agents/other/agent/subagents/reader/agent.ts";
    const { wired } = await stageSubagentModelWiring(
      {
        project: PROJECT,
        memberRoot: "agent",
        candidatePaths: ["agent/subagents/writer/agent.ts", otherMembers],
        createdBy: null,
      },
      store,
      fakeDeps({
        // Already routed through a provider call — nothing to fix.
        "agent/subagents/writer/agent.ts": STATIC_AGENT_TS,
        [otherMembers]: BARE_SUBAGENT,
      }),
    );

    expect(wired).toEqual([]);
    expect(await listDrafts(PROJECT.id, store)).toEqual([]);
  });
});
