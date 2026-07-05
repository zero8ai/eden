/**
 * agent.ts model read/write — pins the authored forms in the wild. Eden writes OpenRouter
 * provider wiring by default so provider-prefixed model ids don't accidentally route through
 * Eve's default Vercel AI Gateway path.
 */
import { describe, expect, it } from "vitest";

import {
  ensureOpenRouterDependency,
  readModel,
  setModel,
} from "~/eve/agentModule";

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
    const next = setModel(WRAPPED, "z-ai/glm-5.2", {
      contextWindowTokens: 131_072,
    });
    expect(next).toContain(`model: openrouter('z-ai/glm-5.2')`);
    expect(next).toContain("modelContextWindowTokens: 131072");
    expect(next.match(/\bmodel\s*:/g)).toHaveLength(1);
    expect(readModel(next)).toBe("z-ai/glm-5.2");
  });

  it("converts a plain string literal to OpenRouter provider wiring", () => {
    const next = setModel(PLAIN, "openai/gpt-5.1", {
      contextWindowTokens: 400_000,
    });
    expect(next).toContain(
      `import { createOpenRouter } from '@openrouter/ai-sdk-provider';`,
    );
    expect(next).toContain(
      `const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY ?? '' });`,
    );
    expect(next).toContain(`model: openrouter('openai/gpt-5.1')`);
    expect(next).toContain("modelContextWindowTokens: 400000");
    expect(readModel(next)).toBe("openai/gpt-5.1");
    expect(next.match(/\bmodel\s*:/g)).toHaveLength(1);
  });

  it("still injects into defineAgent({...}) when no model exists", () => {
    const next = setModel(
      `import { defineAgent } from 'eve';\nexport default defineAgent({\n});\n`,
      "anthropic/claude-haiku-4-5",
    );
    expect(readModel(next)).toBe("anthropic/claude-haiku-4-5");
    expect(next).toContain("model: openrouter('anthropic/claude-haiku-4-5')");
  });

  it("scaffolds OpenRouter wiring when no agent module exists", () => {
    const next = setModel("", "anthropic/claude-sonnet-5");
    expect(next).toContain("@openrouter/ai-sdk-provider");
    expect(next).toContain("model: openrouter('anthropic/claude-sonnet-5')");
    expect(next).toContain("modelContextWindowTokens: 200000");
  });
});

describe("ensureOpenRouterDependency", () => {
  it("adds the provider dependency without dropping existing dependencies", () => {
    const next = ensureOpenRouterDependency(
      JSON.stringify({ dependencies: { eve: "latest", zod: "^3.23.0" } }, null, 2) + "\n",
    );
    expect(JSON.parse(next).dependencies).toEqual({
      "@openrouter/ai-sdk-provider": "^6.0.0-alpha.1",
      eve: "latest",
      zod: "^4.4.3",
    });
  });

  it("keeps package.json unchanged when the dependency already exists", () => {
    const pkg =
      JSON.stringify(
        {
          dependencies: {
            "@openrouter/ai-sdk-provider": "^6.0.0-alpha.1",
            zod: "^4.4.3",
          },
        },
        null,
        2,
      ) + "\n";
    expect(ensureOpenRouterDependency(pkg)).toBe(pkg);
  });

  it("upgrades the old provider pin and zod 3 peer conflict", () => {
    const next = ensureOpenRouterDependency(
      JSON.stringify(
        {
          dependencies: {
            "@openrouter/ai-sdk-provider": "^2.10.0",
            eve: "latest",
            zod: "^3.23.0",
          },
        },
        null,
        2,
      ) + "\n",
    );
    expect(JSON.parse(next).dependencies).toEqual({
      "@openrouter/ai-sdk-provider": "^6.0.0-alpha.1",
      eve: "latest",
      zod: "^4.4.3",
    });
  });
});
