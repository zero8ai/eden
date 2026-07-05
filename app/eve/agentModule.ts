/**
 * Minimal, pure read/write helpers for `agent/agent.ts` (the `defineAgent({...})` entrypoint).
 *
 * We deliberately avoid a full TS parse/print round-trip: for the runtime-config editor we
 * only need to read and set a small set of scalar options (model to start), and a targeted
 * source edit preserves the developer's formatting and comments (D3 — the repo stays theirs).
 * When `agent.ts` is absent we scaffold a minimal valid module.
 */

export const OPENROUTER_PROVIDER_PACKAGE = "@ai-sdk/openai-compatible";
export const OPENROUTER_PROVIDER_VERSION = "^3.0.5";
export const LEGACY_OPENROUTER_PROVIDER_PACKAGE = "@openrouter/ai-sdk-provider";
export const ZOD_PACKAGE = "zod";
export const ZOD_VERSION = "^4.4.3";
export const DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS = 200_000;

/** A curated OpenRouter shortlist for the picker; the UI also allows a free-text override. */
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
// Provider-wrapped form, e.g. `model: openrouter.chatModel("anthropic/claude-sonnet-4.5")`.
// We also keep reading the older `openrouter("...")` shape so existing repos can be migrated.
const MODEL_CALL =
  /(\bmodel\s*:\s*)([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\(\s*(['"`])([^'"`]*)\3/;
const DEFINE_AGENT_OPEN = /defineAgent\s*\(\s*\{/;
const MODEL_CONTEXT =
  /(\bmodelContextWindowTokens\s*:\s*)[\d_]+/;
const MODEL_PROP =
  /\bmodel\s*:\s*(?:[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?\([^)]*\)|['"`][^'"`]*['"`])\s*,?/;
const OPENROUTER_IMPORT = `import { createOpenAICompatible } from '${OPENROUTER_PROVIDER_PACKAGE}';\n`;
const OPENROUTER_FACTORY =
  "const openrouter = createOpenAICompatible({ name: 'openrouter', baseURL: 'https://openrouter.ai/api/v1', apiKey: process.env.OPENROUTER_API_KEY ?? '' });\n";
const LEGACY_OPENROUTER_IMPORT =
  /import\s+\{\s*createOpenRouter\s*\}\s+from\s+['"]@openrouter\/ai-sdk-provider['"];\n?/;
const LEGACY_OPENROUTER_FACTORY =
  /const\s+openrouter\s*=\s*createOpenRouter\(\s*\{\s*apiKey\s*:\s*process\.env\.OPENROUTER_API_KEY\s*\?\?\s*(['"`])[^'"`]*\1\s*\}\s*\);\n?/;

function openRouterModelCall(model: string): string {
  return `openrouter.chatModel('${model}')`;
}

function openRouterModelCallStart(model: string): string {
  return `openrouter.chatModel('${model}'`;
}

/** Read the model string from an agent module, or null if not found. */
export function readModel(source: string): string | null {
  const call = source.match(MODEL_CALL);
  if (call) return call[4];
  const m = source.match(MODEL_LITERAL);
  return m ? m[3] : null;
}

function contextWindow(input?: { contextWindowTokens?: number | null }): number {
  const n = input?.contextWindowTokens;
  return typeof n === "number" && Number.isFinite(n) && n > 0
    ? Math.round(n)
    : DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS;
}

function withOpenRouterWiring(source: string): string {
  let next = source;
  next = next.replace(LEGACY_OPENROUTER_IMPORT, OPENROUTER_IMPORT);
  next = next.replace(LEGACY_OPENROUTER_FACTORY, OPENROUTER_FACTORY);
  if (!next.includes(OPENROUTER_PROVIDER_PACKAGE)) {
    const imports = [...next.matchAll(/^import[^\n]*\n/gm)];
    if (imports.length > 0) {
      const last = imports[imports.length - 1];
      const at = (last.index ?? 0) + last[0].length;
      next = `${next.slice(0, at)}${OPENROUTER_IMPORT}${next.slice(at)}`;
    } else {
      next = `${OPENROUTER_IMPORT}${next}`;
    }
  }

  if (!/\bopenrouter\s*=/.test(next)) {
    const imports = [...next.matchAll(/^import[^\n]*\n/gm)];
    if (imports.length > 0) {
      const last = imports[imports.length - 1];
      const at = (last.index ?? 0) + last[0].length;
      next = `${next.slice(0, at)}\n${OPENROUTER_FACTORY}${next.slice(at)}`;
    } else {
      next = `${OPENROUTER_FACTORY}\n${next}`;
    }
  }
  return next;
}

function withContextWindow(source: string, tokens: number): string {
  const formatted = String(tokens);
  if (MODEL_CONTEXT.test(source)) {
    return source.replace(MODEL_CONTEXT, `$1${formatted}`);
  }
  return source.replace(MODEL_PROP, (match) => {
    const modelLine = match.trimEnd().endsWith(",")
      ? match.trimEnd()
      : `${match.trimEnd()},`;
    return `${modelLine}\n  modelContextWindowTokens: ${formatted},`;
  });
}

/**
 * Return `source` with the model set to `model`. Strategy, in order:
 *  1. Replace an existing provider call's string argument.
 *  2. Convert a plain string literal to OpenRouter provider wiring.
 *  3. Inject an OpenRouter-backed `model:` prop into an existing `defineAgent({ ... })`.
 *  3. Scaffold a fresh module.
 */
export function setModel(
  source: string,
  model: string,
  options?: { contextWindowTokens?: number | null },
): string {
  const safe = model.replace(/['"`\\]/g, "");
  const tokens = contextWindow(options);
  // Replace INSIDE a provider call first — injecting a second `model:` prop would silently
  // lose (object literals: last prop wins) and fail typecheck (duplicate property).
  if (MODEL_CALL.test(source)) {
    const next = source.replace(MODEL_CALL, (_match, prefix) => {
      return `${prefix}${openRouterModelCallStart(safe)}`;
    });
    return withContextWindow(withOpenRouterWiring(next), tokens);
  }
  if (MODEL_LITERAL.test(source)) {
    return withContextWindow(
      withOpenRouterWiring(source.replace(MODEL_LITERAL, `$1${openRouterModelCall(safe)}`)),
      tokens,
    );
  }
  if (DEFINE_AGENT_OPEN.test(source)) {
    const next = source.replace(
      DEFINE_AGENT_OPEN,
      (match) =>
        `${match}\n  model: ${openRouterModelCall(safe)},\n  modelContextWindowTokens: ${tokens},`,
    );
    return withOpenRouterWiring(next);
  }
  return scaffoldAgentModule(safe, { contextWindowTokens: tokens });
}

/** A minimal valid `agent.ts` for a new agent. */
export function scaffoldAgentModule(
  model: string,
  options?: { contextWindowTokens?: number | null },
): string {
  const safe = model.replace(/['"`\\]/g, "");
  const tokens = contextWindow(options);
  return `${OPENROUTER_IMPORT}import { defineAgent } from 'eve';\n\n${OPENROUTER_FACTORY}\nexport default defineAgent({\n  model: ${openRouterModelCall(safe)},\n  modelContextWindowTokens: ${tokens},\n});\n`;
}

export function ensureOpenRouterDependency(packageJson: string | null): string {
  const base = packageJson
    ? (JSON.parse(packageJson) as Record<string, unknown>)
    : {
        private: true,
        type: "module",
        scripts: { dev: "eve dev", build: "eve build" },
      };
  const current =
    base.dependencies && typeof base.dependencies === "object"
      ? (base.dependencies as Record<string, string>)
      : {};
  const providerOk = current[OPENROUTER_PROVIDER_PACKAGE] === OPENROUTER_PROVIDER_VERSION;
  const legacyProviderPresent = current[LEGACY_OPENROUTER_PROVIDER_PACKAGE] !== undefined;
  // The OpenAI-compatible provider tracks AI SDK v7's provider interfaces. Existing Eden
  // scaffolds used zod ^3, so a model save must upgrade it or npm publish checks fail.
  const zodOk = typeof current[ZOD_PACKAGE] === "string" && /\b4\b|4\./.test(current[ZOD_PACKAGE]);
  if (providerOk && !legacyProviderPresent && zodOk) {
    return packageJson ?? JSON.stringify(base, null, 2) + "\n";
  }
  const withoutLegacy = Object.fromEntries(
    Object.entries(current).filter(([name]) => name !== LEGACY_OPENROUTER_PROVIDER_PACKAGE),
  );
  const dependencies = Object.fromEntries(
    Object.entries({
      ...withoutLegacy,
      [OPENROUTER_PROVIDER_PACKAGE]: OPENROUTER_PROVIDER_VERSION,
      ...(zodOk ? {} : { [ZOD_PACKAGE]: ZOD_VERSION }),
    }).sort(([a], [b]) => a.localeCompare(b)),
  );
  return JSON.stringify({ ...base, dependencies }, null, 2) + "\n";
}
