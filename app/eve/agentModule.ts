/**
 * Minimal, pure read/write helpers for `agent/agent.ts` (the `defineAgent({...})` entrypoint).
 *
 * We deliberately avoid a full TS parse/print round-trip: for the runtime-config editor we
 * only need to read and set a small set of scalar options (model to start), and a targeted
 * source edit preserves the developer's formatting and comments (D3 — the repo stays theirs).
 * When `agent.ts` is absent we scaffold a minimal valid module.
 */

/** A curated model shortlist for the picker; the UI also allows a free-text override. */
export const SUGGESTED_MODELS = [
  "anthropic/claude-opus-4-8",
  "anthropic/claude-sonnet-5",
  "anthropic/claude-haiku-4-5",
  "openai/gpt-5.1",
  "google/gemini-3-pro",
  "z-ai/glm-5.2",
  "moonshotai/kimi-k2.7-code",
] as const;

const MODEL_LITERAL = /(\bmodel\s*:\s*)(['"`])([^'"`]*)\2/;
// Provider-wrapped form, e.g. `model: openrouter("anthropic/claude-sonnet-4.5")` — common in
// real repos; the editable model id is the call's string argument.
const MODEL_CALL = /(\bmodel\s*:\s*[A-Za-z_$][\w$]*\(\s*)(['"`])([^'"`]*)\2/;
const DEFINE_AGENT_OPEN = /defineAgent\s*\(\s*\{/;

/** Read the model string from an agent module, or null if not found. */
export function readModel(source: string): string | null {
  const call = source.match(MODEL_CALL);
  if (call) return call[3];
  const m = source.match(MODEL_LITERAL);
  return m ? m[3] : null;
}

/**
 * Return `source` with the model set to `model`. Strategy, in order:
 *  1. Replace an existing `model:` literal (keeps everything else intact).
 *  2. Inject a `model:` prop into an existing `defineAgent({ ... })`.
 *  3. Scaffold a fresh module.
 */
export function setModel(source: string, model: string): string {
  const safe = model.replace(/['"`\\]/g, "");
  // Replace INSIDE a provider call first — injecting a second `model:` prop would silently
  // lose (object literals: last prop wins) and fail typecheck (duplicate property).
  if (MODEL_CALL.test(source)) {
    return source.replace(MODEL_CALL, `$1'${safe}'`);
  }
  if (MODEL_LITERAL.test(source)) {
    return source.replace(MODEL_LITERAL, `$1'${safe}'`);
  }
  if (DEFINE_AGENT_OPEN.test(source)) {
    return source.replace(DEFINE_AGENT_OPEN, (match) => `${match}\n  model: '${safe}',`);
  }
  return scaffoldAgentModule(safe);
}

/** A minimal valid `agent.ts` for a new agent. */
export function scaffoldAgentModule(model: string): string {
  const safe = model.replace(/['"`\\]/g, "");
  return `import { defineAgent } from 'eve';\n\nexport default defineAgent({\n  model: '${safe}',\n});\n`;
}
