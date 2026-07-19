/**
 * The workspace agent-model resolution contract (`pickAgentModel`): an explicit per-agent
 * override always wins, the workspace default answers otherwise, and an unconfigured
 * workspace resolves to nothing — which the model-config endpoint surfaces as a readable
 * "set a model in Org settings" error rather than any silent fallback.
 */
import { describe, expect, it } from "vitest";

import { pickAgentModel } from "~/models/agent-model-config.server";

const OVERRIDE = {
  model: "anthropic/abcdefghijkl/claude-opus-4.8",
  effort: "high" as const,
};
const DEFAULT = {
  model: "openai/mnopqrstuvwx/gpt-5.1",
  effort: "medium" as const,
};

describe("pickAgentModel", () => {
  it("prefers the agent's explicit override over the workspace default", () => {
    expect(pickAgentModel(OVERRIDE, DEFAULT)).toEqual({
      ...OVERRIDE,
      source: "override",
    });
  });

  it("falls back to the workspace default when no override exists", () => {
    expect(pickAgentModel(null, DEFAULT)).toEqual({
      model: DEFAULT.model,
      effort: DEFAULT.effort,
      source: "workspace-default",
    });
  });

  it("keeps the override's own effort even when it is null (no default bleed-through)", () => {
    expect(pickAgentModel({ model: OVERRIDE.model, effort: null }, DEFAULT)).toEqual(
      {
        model: OVERRIDE.model,
        effort: null,
        source: "override",
      },
    );
  });

  it("resolves to nothing when the workspace has no configuration at all", () => {
    expect(pickAgentModel(null, { model: null, effort: null })).toBeNull();
  });
});
