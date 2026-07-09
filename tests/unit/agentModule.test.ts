/**
 * agent.ts model read/write — pins the authored forms in the wild. Eden writes OpenRouter
 * provider wiring by default so provider-prefixed model ids don't accidentally route through
 * Eve's default Vercel AI Gateway path, and wraps the model in `defineDynamic` so the
 * playground's per-conversation model directive works (the chosen model is the fallback).
 */
import { describe, expect, it } from "vitest";

import {
  ensureOpenRouterDependency,
  readModel,
  scaffoldAgentModule,
  setModel,
} from "~/eve/agentModule";

const WRAPPED = `import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { defineAgent } from "eve";

const openrouter = createOpenAICompatible({ name: "openrouter", baseURL: "https://openrouter.ai/api/v1", apiKey: process.env.OPENROUTER_API_KEY ?? "" });

export default defineAgent({
  model: openrouter.chatModel("anthropic/claude-sonnet-4.5"),
  modelContextWindowTokens: 200_000,
});
`;

const LEGACY_WRAPPED = `import { createOpenRouter } from "@openrouter/ai-sdk-provider";
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
  it("reads the defineDynamic fallback of an Eden-written module", () => {
    expect(readModel(scaffoldAgentModule("anthropic/claude-sonnet-5"))).toBe(
      "anthropic/claude-sonnet-5",
    );
  });
  it("reads a user-authored gateway-string fallback", () => {
    const source = `import { defineAgent, defineDynamic } from 'eve';\nexport default defineAgent({\n  model: defineDynamic({ fallback: 'anthropic/claude-sonnet-5', events: {} }),\n});\n`;
    expect(readModel(source)).toBe("anthropic/claude-sonnet-5");
  });
});

/** Structural invariants of the dynamic model wrapper Eden writes. */
function expectDynamicShape(source: string, model: string) {
  expect(source).toContain(
    `fallback: openrouter.chatModel('${model}')`,
  );
  expect(source.match(/model\s*:\s*defineDynamic\s*\(/g)).toHaveLength(1);
  expect(source.match(/function edenSelectedModel/g)).toHaveLength(1);
  expect(source).toMatch(/import\s*\{[^}]*\bdefineDynamic\b[^}]*\}\s*from\s*['"]eve['"]/);
  expect(source).toContain("'step.started'");
  expect(readModel(source)).toBe(model);
}

describe("setModel", () => {
  it("upgrades a static provider call to the dynamic wrapper — never a duplicate model prop", () => {
    const next = setModel(WRAPPED, "z-ai/glm-5.2", {
      contextWindowTokens: 131_072,
    });
    expectDynamicShape(next, "z-ai/glm-5.2");
    expect(next).toContain("modelContextWindowTokens: 131072");
    expect(next.match(/\bmodel\s*:\s*openrouter\.chatModel\(['"`]/g)).toBeNull();
  });

  it("retargets the fallback in place on re-save (idempotent wiring)", () => {
    const first = setModel(WRAPPED, "z-ai/glm-5.2");
    const second = setModel(first, "openai/gpt-5.1", {
      contextWindowTokens: 400_000,
    });
    expectDynamicShape(second, "openai/gpt-5.1");
    expect(second).toContain("modelContextWindowTokens: 400000");
    // No duplicated helper, import, or resolver from repeated saves.
    expect(second.match(/EDEN_MODEL_DIRECTIVE/g)?.length).toBe(2); // const + one use
  });

  it("rewires a user-authored gateway-string fallback to OpenRouter", () => {
    const source = `import { defineAgent, defineDynamic } from 'eve';\n\nexport default defineAgent({\n  model: defineDynamic({ fallback: 'anthropic/claude-sonnet-5', events: {} }),\n});\n`;
    const next = setModel(source, "z-ai/glm-5.2");
    expect(next).toContain("fallback: openrouter.chatModel('z-ai/glm-5.2')");
    expect(next).toContain("@ai-sdk/openai-compatible");
    expect(readModel(next)).toBe("z-ai/glm-5.2");
  });

  it("migrates the legacy OpenRouter provider wiring when setting a model", () => {
    const next = setModel(LEGACY_WRAPPED, "z-ai/glm-5.2");
    expect(next).toContain("@ai-sdk/openai-compatible");
    expect(next).not.toContain("@openrouter/ai-sdk-provider");
    expectDynamicShape(next, "z-ai/glm-5.2");
  });

  it("migrates a legacy factory with trailing commas / multiline formatting", () => {
    // As authored in the wild (eden-spike-agent): prettier adds a trailing comma, which the
    // old factory regex missed — leaving an orphan createOpenRouter call with no import.
    const legacy = `import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { defineAgent } from "eve";

const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY ?? "",
});

export default defineAgent({
  model: openrouter("anthropic/claude-sonnet-4.5"),
});
`;
    const next = setModel(legacy, "z-ai/glm-5.2");
    expect(next).not.toContain("createOpenRouter");
    expect(next).toContain(
      "const openrouter = createOpenAICompatible({ name: 'openrouter', baseURL: 'https://openrouter.ai/api/v1', apiKey: process.env.OPENROUTER_API_KEY ?? '' });",
    );
    expectDynamicShape(next, "z-ai/glm-5.2");
  });

  it("converts a plain string literal to OpenRouter provider wiring", () => {
    const next = setModel(PLAIN, "openai/gpt-5.1", {
      contextWindowTokens: 400_000,
    });
    expect(next).toContain(
      `import { createOpenAICompatible } from '@ai-sdk/openai-compatible';`,
    );
    expect(next).toContain(
      `const openrouter = createOpenAICompatible({ name: 'openrouter', baseURL: 'https://openrouter.ai/api/v1', apiKey: process.env.OPENROUTER_API_KEY ?? '' });`,
    );
    expectDynamicShape(next, "openai/gpt-5.1");
    expect(next).toContain("modelContextWindowTokens: 400000");
  });

  it("still injects into defineAgent({...}) when no model exists", () => {
    const next = setModel(
      `import { defineAgent } from 'eve';\nexport default defineAgent({\n});\n`,
      "anthropic/claude-haiku-4-5",
    );
    expectDynamicShape(next, "anthropic/claude-haiku-4-5");
  });

  it("scaffolds OpenRouter wiring when no agent module exists", () => {
    const next = setModel("", "anthropic/claude-sonnet-5");
    expect(next).toContain("@ai-sdk/openai-compatible");
    expectDynamicShape(next, "anthropic/claude-sonnet-5");
    expect(next).toContain("modelContextWindowTokens: 200000");
  });
});

describe("ensureOpenRouterDependency", () => {
  it("adds the provider dependency without dropping existing dependencies", () => {
    const next = ensureOpenRouterDependency(
      JSON.stringify({ dependencies: { eve: "latest", zod: "^3.23.0" } }, null, 2) + "\n",
    );
    expect(JSON.parse(next).dependencies).toEqual({
      "@ai-sdk/openai-compatible": "^3.0.5",
      eve: "latest",
      zod: "^4.4.3",
    });
  });

  it("keeps package.json unchanged when the dependency already exists", () => {
    const pkg =
      JSON.stringify(
        {
          dependencies: {
            "@ai-sdk/openai-compatible": "^3.0.5",
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
      "@ai-sdk/openai-compatible": "^3.0.5",
      eve: "latest",
      zod: "^4.4.3",
    });
  });
});
