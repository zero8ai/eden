/**
 * agent.ts model read/write — pins the two authored forms in the wild: a plain string
 * (`model: "id"`) and a provider call (`model: openrouter("id")`). The provider-call case
 * previously injected a DUPLICATE model prop, silently losing the user's choice (last prop
 * wins) — the exact dogfooding bug from 2026-07-04.
 */
import { describe, expect, it } from "vitest";

import { readModel, setModel } from "~/eve/agentModule";

const WRAPPED = `import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { defineAgent } from "eve";

const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY ?? "" });

export default defineAgent({
  model: openrouter("anthropic/claude-sonnet-4.5"),
  modelContextWindowTokens: 200_000,
});
`;

const PLAIN = `import { defineAgent } from 'eve';

export default defineAgent({
  model: 'anthropic/claude-sonnet-5',
});
`;

describe("readModel", () => {
  it("reads the string argument of a provider call", () => {
    expect(readModel(WRAPPED)).toBe("anthropic/claude-sonnet-4.5");
  });
  it("reads a plain string literal", () => {
    expect(readModel(PLAIN)).toBe("anthropic/claude-sonnet-5");
  });
});

describe("setModel", () => {
  it("replaces INSIDE the provider call — never injects a duplicate model prop", () => {
    const next = setModel(WRAPPED, "z-ai/glm-5.2");
    expect(next).toContain(`model: openrouter('z-ai/glm-5.2')`);
    expect(next.match(/\bmodel\s*:/g)).toHaveLength(1);
    expect(readModel(next)).toBe("z-ai/glm-5.2");
  });

  it("replaces a plain string literal", () => {
    const next = setModel(PLAIN, "openai/gpt-5.1");
    expect(readModel(next)).toBe("openai/gpt-5.1");
    expect(next.match(/\bmodel\s*:/g)).toHaveLength(1);
  });

  it("still injects into defineAgent({...}) when no model exists", () => {
    const next = setModel(
      `import { defineAgent } from 'eve';\nexport default defineAgent({\n});\n`,
      "anthropic/claude-haiku-4-5",
    );
    expect(readModel(next)).toBe("anthropic/claude-haiku-4-5");
  });
});
