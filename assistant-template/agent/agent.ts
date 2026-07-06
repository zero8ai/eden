import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { defineAgent } from "eve";

// Eden's built-in project assistant. This is the FIXED, Eden-owned layer — do not edit it in a
// user repo; the user layer arrives as instructions/skills/schedules materialized by the
// container entrypoint before `eve build` (see docs/ASSISTANT.md). The model is env-driven so a
// per-project override needs only a restart, not a rebuilt image.
const openrouter = createOpenAICompatible({
  name: "openrouter",
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY ?? "",
});

export default defineAgent({
  model: openrouter.chatModel(
    process.env.EDEN_ASSISTANT_MODEL ?? "anthropic/claude-sonnet-5",
  ),
  modelContextWindowTokens: 200000,
  // Deployable off-Vercel: declare + externalize the Postgres Workflow world (SPIKE-EVE §2).
  build: { externalDependencies: ["@workflow/world-postgres"] },
  experimental: { workflow: { world: "@workflow/world-postgres" } },
});
