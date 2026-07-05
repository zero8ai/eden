import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { defineAgent } from "eve";

const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY ?? "" });

export default defineAgent({
  model: openrouter("anthropic/claude-sonnet-5"),
  modelContextWindowTokens: 1000000,
});
