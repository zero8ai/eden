import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { defineAgent } from "eve";

// Eden's built-in project assistant. This is the FIXED, Eden-owned layer — do not edit it in a
// user repo; the user layer arrives as instructions/skills/schedules materialized by the
// container entrypoint before `eve build`. The model is env-driven so a
// per-project override needs only a restart, not a rebuilt image.
const openrouter = createOpenAICompatible({
  name: "openrouter",
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY ?? "",
});
// Eden's model gateway (issue #28): a `codex/<connection>/<slug>` assistant model runs on the
// org's connected Codex subscription. The base URL + token are injected at deploy only when a
// Codex connection exists; OpenRouter model ids never touch it.
const edenGateway = createOpenAICompatible({
  name: "eden",
  baseURL: process.env.EDEN_MODEL_GATEWAY_URL ?? "",
  apiKey: process.env.EDEN_MODEL_GATEWAY_TOKEN ?? "",
});

const assistantModelId = process.env.EDEN_ASSISTANT_MODEL ?? "z-ai/glm-5.2";

export default defineAgent({
  model: assistantModelId.startsWith("codex/")
    ? edenGateway.chatModel(assistantModelId)
    : openrouter.chatModel(assistantModelId),
  modelContextWindowTokens: 200000,
  // Deployable off-Vercel: declare + externalize the Postgres Workflow world.
  build: { externalDependencies: ["@workflow/world-postgres"] },
  experimental: { workflow: { world: "@workflow/world-postgres" } },
});
