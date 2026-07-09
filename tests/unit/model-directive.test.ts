/**
 * The playground model directive — the one-line transport between the model selector and the
 * deployed agent's dynamic-model resolver. Round-trips must be exact: the same line Eden builds
 * is parsed back for attribution and stripped from every display surface.
 */
import { describe, expect, it } from "vitest";

import {
  buildModelDirective,
  effectiveModelId,
  parseModelDirective,
  stripModelDirective,
} from "~/models/model-directive";

describe("buildModelDirective", () => {
  it("builds the id + context window line", () => {
    expect(
      buildModelDirective({ id: "anthropic/claude-sonnet-5", contextWindowTokens: 200_000 }),
    ).toBe("<!-- eden:model anthropic/claude-sonnet-5 ctx=200000 -->");
  });

  it("omits the context window when unknown", () => {
    expect(buildModelDirective({ id: "openai/gpt-5.1" })).toBe(
      "<!-- eden:model openai/gpt-5.1 -->",
    );
  });

  it("drops characters that could break the comment or the parser", () => {
    expect(buildModelDirective({ id: "we`ird -->id" })).toBe(
      "<!-- eden:model weird--id -->",
    );
  });
});

describe("parseModelDirective", () => {
  it("round-trips what buildModelDirective produced (as a sent-message prefix)", () => {
    const sent = `${buildModelDirective({ id: "z-ai/glm-5.2", contextWindowTokens: 131_072 })}\n\nwhat model are you?`;
    expect(parseModelDirective(sent)).toEqual({
      id: "z-ai/glm-5.2",
      contextWindowTokens: 131_072,
    });
  });

  it("parses a directive without a context window", () => {
    expect(parseModelDirective("<!-- eden:model openai/gpt-5.1 -->\n\nhi")).toEqual({
      id: "openai/gpt-5.1",
      contextWindowTokens: undefined,
    });
  });

  it("returns null when the message has no directive", () => {
    expect(parseModelDirective("just a normal message")).toBeNull();
  });

  it("ignores a directive that is not at the start of the message", () => {
    expect(
      parseModelDirective("look at this: <!-- eden:model openai/gpt-5.1 -->"),
    ).toBeNull();
  });

  it("returns null for malformed directives", () => {
    expect(parseModelDirective("<!-- eden:model -->\n\nhi")).toBeNull();
  });
});

describe("stripModelDirective", () => {
  it("removes the directive line and the blank line after it", () => {
    const sent = "<!-- eden:model anthropic/claude-sonnet-5 ctx=200000 -->\n\nwhat model are you?";
    expect(stripModelDirective(sent)).toBe("what model are you?");
  });

  it("leaves ordinary messages untouched", () => {
    expect(stripModelDirective("2 + 2 = ?")).toBe("2 + 2 = ?");
    expect(stripModelDirective("multi\n\nline")).toBe("multi\n\nline");
  });

  it("leaves a mid-message mention untouched", () => {
    const text = "the line <!-- eden:model x --> is a directive";
    expect(stripModelDirective(text)).toBe(text);
  });
});

describe("effectiveModelId", () => {
  it("returns the static runtime id as-is, ignoring any directive", () => {
    expect(
      effectiveModelId("anthropic/claude-sonnet-5", "<!-- eden:model openai/gpt-5.1 -->\n\nhi"),
    ).toBe("anthropic/claude-sonnet-5");
  });

  it("unwraps the dynamic prefix to the fallback when no directive was sent", () => {
    expect(effectiveModelId("dynamic:anthropic/claude-sonnet-5", "hi")).toBe(
      "anthropic/claude-sonnet-5",
    );
  });

  it("prefers the sent directive for a dynamic-model agent", () => {
    expect(
      effectiveModelId(
        "dynamic:anthropic/claude-sonnet-5",
        "<!-- eden:model openai/gpt-5.1 ctx=400000 -->\n\nhi",
      ),
    ).toBe("openai/gpt-5.1");
  });
});
