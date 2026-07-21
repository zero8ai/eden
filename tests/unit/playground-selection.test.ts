import { describe, expect, it } from "vitest";

import { parseRequestedModelSelection } from "~/models/playground-selection";

describe("parseRequestedModelSelection", () => {
  it("passes a model with a valid effort through", () => {
    expect(
      parseRequestedModelSelection({
        modelId: "codex/abcdefghijkl/gpt-5.6-sol",
        effort: "medium",
      }),
    ).toEqual({
      ok: true,
      modelId: "codex/abcdefghijkl/gpt-5.6-sol",
      effort: "medium",
    });
  });

  it("drops an effort sent without a model instead of rejecting it", () => {
    // Regression: a playground whose agent has a saved effort echoes it on every send even
    // when no model override is picked — that must select nothing, not 400 the stream.
    expect(
      parseRequestedModelSelection({ modelId: "", effort: "medium" }),
    ).toEqual({ ok: true, modelId: null, effort: null });
    expect(
      parseRequestedModelSelection({ modelId: "  ", effort: "garbage" }),
    ).toEqual({ ok: true, modelId: null, effort: null });
  });

  it("rejects an invalid effort attached to a model", () => {
    expect(
      parseRequestedModelSelection({
        modelId: "codex/abcdefghijkl/gpt-5.6-sol",
        effort: "turbo",
      }),
    ).toEqual({ ok: false, error: "That reasoning effort is not valid." });
  });

  it("treats a model without an effort as effort-unset", () => {
    expect(
      parseRequestedModelSelection({
        modelId: "openai/abcdefghijkl/gpt-5.4",
        effort: "",
      }),
    ).toEqual({ ok: true, modelId: "openai/abcdefghijkl/gpt-5.4", effort: null });
  });
});
