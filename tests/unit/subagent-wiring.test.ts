/**
 * Subagent model wiring — the systemic fix for subagents that ship a bare model literal that eve
 * routes through the (Eden-unprovisioned) Vercel AI Gateway. Pins the detector, the auto-wire
 * transform, and the merge-gate guard that blocks the bad shape from being merged.
 */
import { describe, expect, it, vi } from "vitest";

import { bareGatewayModel, readModel } from "~/eve/agentModule";
import {
  findGatewayBoundSubagents,
  gatewayBoundSubagentError,
  isSubagentAgentPath,
  resolveBareSubagentModel,
  unresolvedSubagentModelError,
  wireSubagentModels,
} from "~/models/subagent-wiring";
import { runConversationMergeGate } from "~/assistant/merge-gate.server";
import type { BuildCheckRequest, BuildCheckResult } from "~/seams/types";

const BARE = `import { defineAgent } from "eve";

export default defineAgent({
  description: "Read-only invoice airlock.",
  model: "anthropic/claude-sonnet-5",
});
`;

// A subagent that already routes through a provider factory (not the gateway) — must NOT be flagged.
const PROVIDER_CALL = `import { defineAgent } from "eve";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
const openrouter = createOpenAICompatible({ name: "openrouter", baseURL: "https://openrouter.ai/api/v1", apiKey: process.env.OPENROUTER_API_KEY ?? "" });
export default defineAgent({
  description: "Reader.",
  model: openrouter.chatModel("anthropic/claude-sonnet-5"),
});
`;

// A subagent with no model at all — inherits the parent, which is fine.
const INHERITS = `import { defineAgent } from "eve";
export default defineAgent({ description: "Reader." });
`;

describe("bareGatewayModel", () => {
  it("returns the literal id for a bare model string", () => {
    expect(bareGatewayModel(BARE)).toBe("anthropic/claude-sonnet-5");
  });
  it("returns null for a provider-call model (already routed)", () => {
    expect(bareGatewayModel(PROVIDER_CALL)).toBeNull();
  });
  it("returns null when there is no model (inherits parent)", () => {
    expect(bareGatewayModel(INHERITS)).toBeNull();
  });
  it("returns null once the model is the Eden dynamic wrapper", () => {
    const wired = wireSubagentModels({ "a/subagents/r/agent.ts": BARE })
      .changed[0]!;
    expect(bareGatewayModel(wired.content)).toBeNull();
  });
});

describe("isSubagentAgentPath", () => {
  it("matches subagent entrypoints at any member depth", () => {
    expect(isSubagentAgentPath("agent/subagents/reader/agent.ts")).toBe(true);
    expect(
      isSubagentAgentPath("agents/bookkeeping/agent/subagents/reader/agent.ts"),
    ).toBe(true);
  });
  it("rejects the member root agent.ts and non-agent files", () => {
    expect(isSubagentAgentPath("agents/bookkeeping/agent/agent.ts")).toBe(false);
    expect(
      isSubagentAgentPath("agents/x/agent/subagents/reader/instructions.md"),
    ).toBe(false);
    expect(
      isSubagentAgentPath("agents/x/agent/subagents/reader/tools/read.ts"),
    ).toBe(false);
  });
});

describe("findGatewayBoundSubagents", () => {
  it("flags only gateway-bound subagent agent.ts files", () => {
    const found = findGatewayBoundSubagents({
      "agents/x/agent/agent.ts": BARE, // member root — handled by the model tooling, not here
      "agents/x/agent/subagents/reader/agent.ts": BARE,
      "agents/x/agent/subagents/writer/agent.ts": PROVIDER_CALL,
      "agents/x/agent/subagents/noop/agent.ts": INHERITS,
      "agents/x/agent/subagents/gone/agent.ts": null, // deletion draft
    });
    expect(found).toEqual([
      {
        path: "agents/x/agent/subagents/reader/agent.ts",
        model: "anthropic/claude-sonnet-5",
      },
    ]);
  });
});

describe("wireSubagentModels", () => {
  it("routes a bare subagent model through the Eden dynamic wrapper, preserving the model", () => {
    const { changed, unresolved } = wireSubagentModels({
      "agents/x/agent/subagents/reader/agent.ts": BARE,
    });
    expect(changed).toHaveLength(1);
    expect(unresolved).toEqual([]);
    const out = changed[0]!.content;
    expect(out).toContain("defineDynamic");
    expect(out).toContain("edenModel(");
    expect(out).toContain("openrouter");
    // The chosen model is preserved as the dynamic fallback.
    expect(readModel(out)).toBe("anthropic/claude-sonnet-5");
    expect(bareGatewayModel(out)).toBeNull();
  });
  it("writes the resolver's qualified ref so the subagent runs on that exact connection", () => {
    const { changed, unresolved } = wireSubagentModels(
      { "agents/x/agent/subagents/reader/agent.ts": BARE },
      () => ({
        kind: "qualified",
        model: "anthropic/abcdefghijkl/claude-sonnet-5",
        contextWindowTokens: 200_000,
      }),
    );
    expect(unresolved).toEqual([]);
    const out = changed[0]!.content;
    expect(readModel(out)).toBe("anthropic/abcdefghijkl/claude-sonnet-5");
    expect(out).toContain("modelContextWindowTokens: 200000");
    expect(bareGatewayModel(out)).toBeNull();
  });
  it("leaves an unresolvable model untouched and reports it (never wires a ref that can't run)", () => {
    const files = { "agents/x/agent/subagents/reader/agent.ts": BARE };
    const { changed, unresolved } = wireSubagentModels(files, () => ({
      kind: "unresolvable",
      reason: "no-connection",
    }));
    expect(changed).toEqual([]);
    expect(unresolved).toEqual([
      {
        path: "agents/x/agent/subagents/reader/agent.ts",
        model: "anthropic/claude-sonnet-5",
        reason: "no-connection",
      },
    ]);
    // Still bare — the publish gate keeps blocking it.
    expect(findGatewayBoundSubagents(files)).toHaveLength(1);
  });
  it("is idempotent and leaves already-routed subagents untouched", () => {
    const files = {
      "agents/x/agent/subagents/writer/agent.ts": PROVIDER_CALL,
      "agents/x/agent/subagents/noop/agent.ts": INHERITS,
    };
    expect(wireSubagentModels(files)).toEqual({ changed: [], unresolved: [] });
  });
  it("never rewrites an interpolated template-literal model (the gate still blocks it)", () => {
    const interpolated = `import { defineAgent } from "eve";
export default defineAgent({ description: "Reader.", model: \`anthropic/\${process.env.SUB_MODEL}\` });
`;
    const files = { "agents/x/agent/subagents/reader/agent.ts": interpolated };
    // Detected (it still routes to the gateway) but not auto-rewritten — freezing the
    // interpolation into a static string would silently change what the author wrote.
    expect(findGatewayBoundSubagents(files)).toHaveLength(1);
    expect(wireSubagentModels(files)).toEqual({ changed: [], unresolved: [] });
  });
});

describe("resolveBareSubagentModel", () => {
  /** Workspace-catalog rows as `listWorkspaceModelCatalog` qualifies them. */
  const anthropicEntry = {
    id: "anthropic/aaaaaaaaaaaa/claude-sonnet-5",
    provider: "anthropic" as const,
    upstreamModelId: "claude-sonnet-5",
    contextWindow: 200_000,
  };
  const openRouterEntry = {
    id: "openrouter/bbbbbbbbbbbb/anthropic/claude-sonnet-5",
    provider: "openrouter" as const,
    upstreamModelId: "anthropic/claude-sonnet-5",
    contextWindow: 195_000,
  };
  const available = { openRouterCatalogUnavailable: false };

  it("qualifies against the single active connection that carries the model", () => {
    expect(
      resolveBareSubagentModel(
        "anthropic/claude-sonnet-5",
        [anthropicEntry],
        available,
      ),
    ).toEqual({
      kind: "qualified",
      model: "anthropic/aaaaaaaaaaaa/claude-sonnet-5",
      contextWindowTokens: 200_000,
    });
  });

  it("matches a Codex model under the openai/ creator segment", () => {
    expect(
      resolveBareSubagentModel(
        "openai/gpt-5.2-codex",
        [
          {
            id: "codex/cccccccccccc/gpt-5.2-codex",
            provider: "codex" as const,
            upstreamModelId: "gpt-5.2-codex",
            contextWindow: null,
          },
        ],
        available,
      ),
    ).toEqual({
      kind: "qualified",
      model: "codex/cccccccccccc/gpt-5.2-codex",
      contextWindowTokens: null,
    });
  });

  it("prefers the sole OpenRouter match when several providers carry the model", () => {
    // A bare id IS OpenRouter's id format — qualifying there preserves today's routing while
    // pinning the exact connection credential.
    expect(
      resolveBareSubagentModel(
        "anthropic/claude-sonnet-5",
        [anthropicEntry, openRouterEntry],
        available,
      ),
    ).toEqual({
      kind: "qualified",
      model: "openrouter/bbbbbbbbbbbb/anthropic/claude-sonnet-5",
      contextWindowTokens: 195_000,
    });
  });

  it("reports ambiguity when several non-OpenRouter connections carry the model", () => {
    expect(
      resolveBareSubagentModel(
        "anthropic/claude-sonnet-5",
        [
          anthropicEntry,
          { ...anthropicEntry, id: "anthropic/dddddddddddd/claude-sonnet-5" },
        ],
        available,
      ),
    ).toEqual({ kind: "unresolvable", reason: "ambiguous" });
  });

  it("keeps the alias when several OpenRouter connections carry the model (status quo)", () => {
    expect(
      resolveBareSubagentModel(
        "anthropic/claude-sonnet-5",
        [
          openRouterEntry,
          {
            ...openRouterEntry,
            id: "openrouter/eeeeeeeeeeee/anthropic/claude-sonnet-5",
          },
        ],
        available,
      ),
    ).toEqual({ kind: "alias" });
  });

  it("reports no-connection when nothing in the workspace carries the model", () => {
    expect(
      resolveBareSubagentModel("anthropic/claude-sonnet-5", [], available),
    ).toEqual({ kind: "unresolvable", reason: "no-connection" });
  });

  it("fails open to the alias when OpenRouter's catalog could not be listed", () => {
    expect(
      resolveBareSubagentModel("anthropic/claude-sonnet-5", [], {
        openRouterCatalogUnavailable: true,
      }),
    ).toEqual({ kind: "alias" });
  });
});

describe("unresolvedSubagentModelError", () => {
  it("names each offender, the reason, and the connect-a-provider fix", () => {
    const msg = unresolvedSubagentModelError([
      {
        path: "agents/x/agent/subagents/reader/agent.ts",
        model: "anthropic/claude-sonnet-5",
        reason: "no-connection",
      },
    ]);
    expect(msg).toContain("agents/x/agent/subagents/reader/agent.ts");
    expect(msg).toContain("anthropic/claude-sonnet-5");
    expect(msg).toContain("no active provider connection");
    expect(msg).toContain("Connect a provider");
  });
  it("distinguishes the ambiguous case", () => {
    const msg = unresolvedSubagentModelError([
      {
        path: "agents/x/agent/subagents/reader/agent.ts",
        model: "anthropic/claude-sonnet-5",
        reason: "ambiguous",
      },
    ]);
    expect(msg).toContain("several connections");
  });
});

describe("gatewayBoundSubagentError", () => {
  it("names each offender and its model", () => {
    const msg = gatewayBoundSubagentError([
      { path: "agents/x/agent/subagents/reader/agent.ts", model: "anthropic/claude-sonnet-5" },
    ]);
    expect(msg).toContain("agents/x/agent/subagents/reader/agent.ts");
    expect(msg).toContain("anthropic/claude-sonnet-5");
    expect(msg).toContain("Settings → Model");
  });
});

describe("merge gate: subagent model guard", () => {
  const REPO = { owner: "acme", repo: "team-repo" };
  type CheckBuildFn = (req: BuildCheckRequest) => Promise<BuildCheckResult>;
  const okCheck = () => vi.fn<CheckBuildFn>(async () => ({ ok: true }));

  it("blocks merging a branch that introduces a gateway-bound subagent (before the build)", async () => {
    const checkBuild = okCheck();
    const result = await runConversationMergeGate({
      projectId: "p1",
      repo: REPO,
      ref: "conv-branch",
      installationId: "inst-1",
      teamLayout: true,
      paths: ["agents/x/agent/subagents/reader/agent.ts"],
      checkBuild,
      readFile: async () => BARE,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected block");
    expect(result.error).toContain("reader/agent.ts");
    // Fails fast: the slower build check never runs.
    expect(checkBuild).not.toHaveBeenCalled();
  });

  it("passes a branch whose subagent is already routed", async () => {
    const result = await runConversationMergeGate({
      projectId: "p1",
      repo: REPO,
      ref: "conv-branch",
      installationId: "inst-1",
      teamLayout: true,
      paths: ["agents/x/agent/subagents/writer/agent.ts"],
      checkBuild: okCheck(),
      readFile: async () => PROVIDER_CALL,
    });
    expect(result.ok).toBe(true);
  });

  it("skips the check when no repo reader is injected (fail-open backstop)", async () => {
    const result = await runConversationMergeGate({
      projectId: "p1",
      repo: REPO,
      ref: "conv-branch",
      installationId: "inst-1",
      teamLayout: true,
      paths: ["agents/x/agent/subagents/reader/agent.ts"],
      checkBuild: okCheck(),
    });
    expect(result.ok).toBe(true);
  });
});
