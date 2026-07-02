/**
 * OSS reference AuthoringAssistant: a one-shot Claude generator for eve tool code.
 *
 * Uses the Anthropic SDK (Messages API + structured outputs) with Claude Opus 4.8 to turn a
 * PM's description into a `defineTool(...)` module. This is the non-interactive path — good
 * for "generate a tool from a sentence". The Pi adapter (pi.server.ts) is the richer,
 * interactive path against a working-branch checkout (D4).
 *
 * Requires ANTHROPIC_API_KEY. When unset, callers catch the thrown error and show an
 * "assistant not configured" state, so the app still runs without it.
 */
import Anthropic from "@anthropic-ai/sdk";

import { normalizeAgentPath } from "~/project/guard.server";
import type {
  AuthoringAssistant,
  GeneratedTool,
  GenerateToolInput,
} from "./types";

const MODEL = "claude-opus-4-8";

const SYSTEM = `You generate TypeScript tools for the eve agent framework.

An eve tool is a file under agent/tools/ that default-exports defineTool({ ... }) from 'eve'.
Shape:

  import { defineTool } from 'eve';
  import { z } from 'zod';

  export default defineTool({
    description: 'Concise description the model uses to decide when to call this.',
    inputSchema: z.object({ /* zod fields, each .describe()'d */ }),
    async execute(input, ctx) { /* implementation; return a JSON-serializable result */ },
    // optional: needsApproval, outputSchema, toModelOutput
  });

Rules:
- Reference secrets by name via process.env.SECRET_NAME — never inline secret values.
- Keep the implementation realistic but self-contained; use fetch/standard APIs.
- The file must be valid TypeScript. Prefer clarity over cleverness.
- The tool file name is snake_case derived from the tool's purpose.`;

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    fileName: {
      type: "string",
      description: "snake_case base name, no extension, e.g. order_lookup",
    },
    content: { type: "string", description: "the full defineTool TypeScript module" },
    explanation: {
      type: "string",
      description: "1-3 sentences of plain language for a non-developer",
    },
    secretsNeeded: {
      type: "array",
      items: { type: "string" },
      description: "env var names the tool reads (empty if none)",
    },
  },
  required: ["fileName", "content", "explanation", "secretsNeeded"],
} as const;

interface RawOutput {
  fileName: string;
  content: string;
  explanation: string;
  secretsNeeded: string[];
}

export const claudeAuthoringAssistant: AuthoringAssistant = {
  name: "claude-opus-4-8",

  async generateTool(input: GenerateToolInput): Promise<GeneratedTool> {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error(
        "ANTHROPIC_API_KEY is not set — the authoring assistant needs a model key. " +
          "Add it to .env.local to enable tool generation.",
      );
    }
    const client = new Anthropic();

    const userText = input.existingTool
      ? `Edit this existing tool per the request.\n\nRequest: ${input.instruction}\n\nCurrent file (${input.existingTool.path}):\n\n${input.existingTool.content}`
      : `Create a new eve tool.\n\nRequest: ${input.instruction}`;

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      system: SYSTEM,
      output_config: { format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
      messages: [{ role: "user", content: userText }],
    });

    const text = response.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") {
      throw new Error("Assistant returned no structured output.");
    }
    const raw = JSON.parse(text.text) as RawOutput;

    const base = raw.fileName.replace(/[^a-zA-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
    const path =
      normalizeAgentPath(`agent/tools/${base || "tool"}.ts`) ??
      "agent/tools/tool.ts";

    return {
      path,
      content: raw.content,
      explanation: raw.explanation,
      secretsNeeded: Array.isArray(raw.secretsNeeded) ? raw.secretsNeeded : [],
    };
  },
};
