import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { defineAgent, defineDynamic } from "eve";

const openrouter = createOpenAICompatible({
  name: "openrouter",
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY ?? "",
});

// Eden playground model override: the playground pins a model per conversation by
// prefixing the sent message with one machine-readable line, e.g.
//   <!-- eden:model anthropic/claude-sonnet-5 ctx=200000 -->
// Eden strips that line from every transcript surface; here it picks the model per step.
const EDEN_MODEL_DIRECTIVE = /<!--\s*eden:model\s+(\S+?)(?:\s+ctx=(\d+))?\s*-->/;
function edenSelectedModel(
  messages: ReadonlyArray<{ role: string; content: unknown }>,
): { id: string; contextWindowTokens: number | undefined } | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const entry = messages[i];
    if (!entry || entry.role !== 'user') continue;
    const text =
      typeof entry.content === 'string'
        ? entry.content
        : Array.isArray(entry.content)
          ? entry.content
              .map((part) =>
                part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
                  ? (part as { text: string }).text
                  : '',
              )
              .join('\n')
          : '';
    const match = text.match(EDEN_MODEL_DIRECTIVE);
    if (match?.[1]) {
      return { id: match[1], contextWindowTokens: match[2] ? Number(match[2]) : undefined };
    }
  }
  return null;
}

export default defineAgent({
  model: defineDynamic({
    fallback: openrouter.chatModel('z-ai/glm-5.2'),
    events: {
      'step.started': (_event, ctx) => {
        const selected = edenSelectedModel(ctx.messages);
        if (!selected) return null; // no directive -> the fallback model above
        return { model: openrouter.chatModel(selected.id), modelContextWindowTokens: selected.contextWindowTokens };
      },
    },
  }),
  modelContextWindowTokens: 1000000,
});
