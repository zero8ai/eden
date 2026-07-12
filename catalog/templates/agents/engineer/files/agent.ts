import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createHmac, timingSafeEqual } from "node:crypto";
import { defineAgent, defineDynamic } from "eve";

const openrouter = createOpenAICompatible({
  name: "openrouter",
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY ?? "",
});
const edenGateway = createOpenAICompatible({
  name: "eden",
  baseURL: process.env.EDEN_MODEL_GATEWAY_URL ?? "",
  apiKey: process.env.EDEN_MODEL_GATEWAY_TOKEN ?? "",
});

// Eden playground model override: the playground pins a model per conversation by
// prefixing the sent message with one machine-readable line, e.g.
//   <!-- eden:model anthropic/<connection>/claude-sonnet-5 ctx=200000 -->
//   <!-- eden:sig <hmac> -->
// Eden strips that line from every transcript surface; here it picks the model per step.
const EDEN_MODEL_DIRECTIVE =
  /^<!--\s*eden:model\s+(\S+?)(?:\s+ctx=(\d+))?\s*-->\n<!--\s*eden:sig\s+([a-f0-9]{64})\s*-->\n\n([\s\S]*)$/;
function edenSelectedModel(
  messages: ReadonlyArray<{ role: string; content: unknown }>,
): { id: string; contextWindowTokens: number | undefined } | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const entry = messages[i];
    if (!entry || entry.role !== "user") continue;
    const text =
      typeof entry.content === "string"
        ? entry.content
        : Array.isArray(entry.content)
          ? entry.content
              .map((part) =>
                part &&
                typeof part === "object" &&
                typeof (part as { text?: unknown }).text === "string"
                  ? (part as { text: string }).text
                  : "",
              )
              .join("\n")
          : "";
    const match = text.match(EDEN_MODEL_DIRECTIVE);
    const secret = process.env.EDEN_MODEL_DIRECTIVE_SECRET;
    if (match?.[1] && match[3] && secret) {
      const expected = createHmac("sha256", secret)
        .update(match[1] + "\n" + (match[2] ?? "") + "\n" + match[4])
        .digest();
      const received = Buffer.from(match[3], "hex");
      if (
        received.length !== expected.length ||
        !timingSafeEqual(received, expected)
      ) {
        continue;
      }
      return {
        id: match[1],
        contextWindowTokens: match[2] ? Number(match[2]) : undefined,
      };
    }
  }
  return null;
}

// Qualified API-key references call their provider directly with the exact connection key.
// Codex OAuth alone uses Eden's translating gateway; bare ids retain legacy OpenRouter support.
function edenModel(id: string) {
  const qualified = id.match(
    /^(anthropic|codex|openai|openrouter)\/([a-z]{12})\/(.+)$/,
  );
  if (!qualified) return openrouter.chatModel(id);
  const provider = qualified[1];
  const connectionId = qualified[2];
  const upstreamModelId = qualified[3];
  if (provider === "codex") return edenGateway.chatModel(id);
  const envName =
    "EDEN_PROVIDER_" +
    provider.toUpperCase() +
    "_" +
    connectionId.toUpperCase() +
    "_API_KEY";
  const apiKey = process.env[envName];
  if (!apiKey) {
    throw new Error(
      "No credential was deployed for the selected " +
        provider +
        " connection.",
    );
  }
  if (provider === "anthropic") {
    return createAnthropic({
      name: "anthropic/" + connectionId,
      apiKey,
    }).chat(upstreamModelId);
  }
  if (provider === "openai") {
    return createOpenAI({ name: "openai/" + connectionId, apiKey }).responses(
      upstreamModelId,
    );
  }
  return createOpenAICompatible({
    name: "openrouter/" + connectionId,
    baseURL: "https://openrouter.ai/api/v1",
    apiKey,
  }).chatModel(upstreamModelId);
}

export default defineAgent({
  model: defineDynamic({
    // The marketplace planner replaces this sentinel with the active workspace default.
    fallback: edenModel("__EDEN_WORKSPACE_DEFAULT__"),
    events: {
      "step.started": (_event, ctx) => {
        const selected = edenSelectedModel(ctx.messages);
        if (!selected) return null;
        return {
          model: edenModel(selected.id),
          modelContextWindowTokens: selected.contextWindowTokens,
        };
      },
    },
  }),
  modelContextWindowTokens: 1000000,
});
