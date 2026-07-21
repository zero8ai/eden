import { describe, expect, it } from "vitest";

import {
  classifyReasoningCapability,
  reasoningUpstreamModelId,
} from "~/models/reasoning";

const capability = { supportedEfforts: ["low", "medium", "high"] };

describe("classifyReasoningCapability", () => {
  it("uses OpenRouter's supported_parameters metadata", () => {
    expect(
      classifyReasoningCapability({
        provider: "openrouter",
        modelId: "vendor/new-model",
        supportedParameters: ["tools", "reasoning"],
      }),
    ).toEqual(capability);
    expect(
      classifyReasoningCapability({
        provider: "openrouter",
        modelId: "openai/gpt-5",
        supportedParameters: ["tools"],
      }),
    ).toBeNull();
  });

  it.each([
    ["openai", "o3-pro"],
    ["anthropic", "claude-3-7-sonnet-latest"],
    ["anthropic", "claude-sonnet-4-5-20250929"],
  ] as const)(
    "recognizes maintained %s model family %s",
    (provider, modelId) => {
      expect(classifyReasoningCapability({ provider, modelId })).toEqual(
        capability,
      );
    },
  );

  it("preserves newer OpenAI effort levels", () => {
    for (const modelId of ["gpt-5.4", "gpt-5.5", "gpt-5.6-sol"]) {
      expect(
        classifyReasoningCapability({ provider: "openai", modelId }),
        modelId,
      ).toEqual({
        supportedEfforts: ["none", "low", "medium", "high", "xhigh"],
      });
    }
  });

  it("uses the GPT-5.1 effort set", () => {
    expect(
      classifyReasoningCapability({
        provider: "openai",
        modelId: "gpt-5.1-codex",
      }),
    ).toEqual({ supportedEfforts: ["none", "low", "medium", "high"] });
  });

  it.each([
    ["openai", "gpt-4.1"],
    ["anthropic", "claude-3-5-sonnet-latest"],
    ["openrouter", "openai/gpt-5"],
  ] as const)("does not guess unsupported %s model %s", (provider, modelId) => {
    expect(classifyReasoningCapability({ provider, modelId })).toBeNull();
  });

  it("accepts connection-qualified ids", () => {
    expect(
      reasoningUpstreamModelId("openai", "openai/abcdefghijkl/gpt-5.4"),
    ).toBe("gpt-5.4");
    expect(
      classifyReasoningCapability({
        provider: "openai",
        modelId: "openai/abcdefghijkl/o3-pro",
      }),
    ).toEqual(capability);
  });
});
