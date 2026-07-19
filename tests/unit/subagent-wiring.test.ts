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
    const wired = wireSubagentModels({ "a/subagents/r/agent.ts": BARE })[0]!;
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
    const changed = wireSubagentModels({
      "agents/x/agent/subagents/reader/agent.ts": BARE,
    });
    expect(changed).toHaveLength(1);
    const out = changed[0]!.content;
    expect(out).toContain("defineDynamic");
    expect(out).toContain("edenModel(");
    expect(out).toContain("openrouter");
    // The chosen model is preserved as the dynamic fallback.
    expect(readModel(out)).toBe("anthropic/claude-sonnet-5");
    expect(bareGatewayModel(out)).toBeNull();
  });
  it("is idempotent and leaves already-routed subagents untouched", () => {
    const files = {
      "agents/x/agent/subagents/writer/agent.ts": PROVIDER_CALL,
      "agents/x/agent/subagents/noop/agent.ts": INHERITS,
    };
    expect(wireSubagentModels(files)).toEqual([]);
  });
  it("never rewrites an interpolated template-literal model (the gate still blocks it)", () => {
    const interpolated = `import { defineAgent } from "eve";
export default defineAgent({ description: "Reader.", model: \`anthropic/\${process.env.SUB_MODEL}\` });
`;
    const files = { "agents/x/agent/subagents/reader/agent.ts": interpolated };
    // Detected (it still routes to the gateway) but not auto-rewritten — freezing the
    // interpolation into a static string would silently change what the author wrote.
    expect(findGatewayBoundSubagents(files)).toHaveLength(1);
    expect(wireSubagentModels(files)).toEqual([]);
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
