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
export const EVE_PACKAGE = "eve";
/** `defineDynamic` (root export) first shipped in eve@0.22.0 — the generated model wrapper needs it. */
export const EVE_MIN_VERSION = "^0.22.0";
export const DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS = 200_000;

/** A curated OpenRouter shortlist for the picker; the UI also allows a free-text override. */
export const SUGGESTED_MODELS = [
  "anthropic/claude-opus-4.8",
  "anthropic/claude-sonnet-5",
  "anthropic/claude-haiku-4.5",
  "openai/gpt-5.1",
  "google/gemini-3.1-pro-preview",
  "z-ai/glm-5.2",
  "moonshotai/kimi-k2.7-code",
] as const;

const MODEL_LITERAL = /(\bmodel\s*:\s*)(['"`])([^'"`]*)\2/;
// Provider-wrapped form, e.g. `model: openrouter.chatModel("anthropic/claude-sonnet-4.5")`.
// We also keep reading the older `openrouter("...")` shape so existing repos can be migrated.
const MODEL_CALL =
  /(\bmodel\s*:\s*)([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\(\s*(['"`])([^'"`]*)\3/;
// The same provider call, matched to its closing paren — used when the whole value is replaced
// (upgrading a static model to the Eden dynamic wrapper below).
const MODEL_CALL_FULL =
  /(\bmodel\s*:\s*)[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?\(\s*(['"`])[^'"`]*\2\s*\)/;
// Eden's dynamic wrapper: `model: defineDynamic({ fallback: openrouter.chatModel('id'), … })`.
// The deploy-default id lives in the fallback; the resolver honors the playground's
// per-conversation directive (see ~/models/model-directive).
const MODEL_DYNAMIC = /\bmodel\s*:\s*defineDynamic\s*\(/;
const FALLBACK_CALL =
  /(\bfallback\s*:\s*)([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\(\s*(['"`])([^'"`]*)\3/;
const FALLBACK_LITERAL = /\bfallback\s*:\s*(['"`])([^'"`]*)\1/;
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
  /const\s+openrouter\s*=\s*createOpenRouter\(\s*\{\s*apiKey\s*:\s*process\.env\.OPENROUTER_API_KEY\s*\?\?\s*(['"`])[^'"`]*\1\s*,?\s*\}\s*,?\s*\)\s*;?\n?/;

function openRouterModelCall(model: string): string {
  return `openrouter.chatModel('${model}')`;
}

function openRouterModelCallStart(model: string): string {
  return `openrouter.chatModel('${model}'`;
}

/**
 * The message-directive parser injected into `agent.ts` alongside the dynamic model wrapper.
 * Its regex must stay in sync with `~/models/model-directive` (the Eden-side builder/stripper).
 * Kept dependency-free (structural message type) so it compiles in any agent repo.
 */
const EDEN_MODEL_HELPER = `// Eden playground model override: the playground pins a model per conversation by
// prefixing the sent message with one machine-readable line, e.g.
//   <!-- eden:model anthropic/claude-sonnet-5 ctx=200000 -->
// Eden strips that line from every transcript surface; here it picks the model per step.
const EDEN_MODEL_DIRECTIVE = /<!--\\s*eden:model\\s+(\\S+?)(?:\\s+ctx=(\\d+))?\\s*-->/;
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
              .join('\\n')
          : '';
    const match = text.match(EDEN_MODEL_DIRECTIVE);
    if (match?.[1]) {
      return { id: match[1], contextWindowTokens: match[2] ? Number(match[2]) : undefined };
    }
  }
  return null;
}
`;

/** The `model:` value Eden writes — deploy default as the fallback, directive override per step. */
function dynamicModelValue(model: string): string {
  return `defineDynamic({
    fallback: ${openRouterModelCall(model)},
    events: {
      'step.started': (_event, ctx) => {
        const selected = edenSelectedModel(ctx.messages);
        if (!selected) return null; // no directive -> the fallback model above
        return { model: openrouter.chatModel(selected.id), modelContextWindowTokens: selected.contextWindowTokens };
      },
    },
  })`;
}

/**
 * True when the module's `model:` is the Eden dynamic wrapper — i.e. a build of this source
 * honors the playground's per-conversation model directive. A static module (plain provider
 * call or bare string) ignores the directive and always runs its baked-in model.
 */
export function hasDynamicModel(source: string | null | undefined): boolean {
  return typeof source === "string" && MODEL_DYNAMIC.test(source);
}

/** Read the model string from an agent module, or null if not found. */
export function readModel(source: string): string | null {
  if (MODEL_DYNAMIC.test(source)) {
    const fallbackCall = source.match(FALLBACK_CALL);
    if (fallbackCall) return fallbackCall[4];
    const fallbackLiteral = source.match(FALLBACK_LITERAL);
    if (fallbackLiteral) return fallbackLiteral[2];
  }
  const call = source.match(MODEL_CALL);
  if (call) return call[4];
  const m = source.match(MODEL_LITERAL);
  return m ? m[3] : null;
}

/** Read the declared `modelContextWindowTokens` from an agent module, or null if absent. */
export function readModelContextWindow(source: string): number | null {
  const match = source.match(/\bmodelContextWindowTokens\s*:\s*([\d_]+)/);
  if (!match) return null;
  const tokens = Number(match[1].replaceAll("_", ""));
  return Number.isFinite(tokens) && tokens > 0 ? tokens : null;
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

/** Ensure the `defineDynamic` import (value import from 'eve') and the directive helper exist. */
function withEdenDynamicWiring(source: string): string {
  let next = source;
  const hasDynamicImport =
    /import\s*(?!type\b)[^;]*\bdefineDynamic\b[^;]*from\s*['"]eve['"]/.test(next);
  if (!hasDynamicImport) {
    const eveImport = /import\s*\{([^}]*)\}\s*from\s*(['"])eve\2/;
    next = eveImport.test(next)
      ? next.replace(
          eveImport,
          (_match, names: string, quote: string) =>
            `import {${names.trimEnd()}, defineDynamic } from ${quote}eve${quote}`,
        )
      : `import { defineDynamic } from 'eve';\n${next}`;
  }
  if (!next.includes("function edenSelectedModel")) {
    next = /(^|\n)export default defineAgent/.test(next)
      ? next.replace(/(^|\n)(export default defineAgent)/, `$1${EDEN_MODEL_HELPER}\n$2`)
      : `${next}\n${EDEN_MODEL_HELPER}`;
  }
  return next;
}

/**
 * Return `source` with the model set to `model`. Eden always writes the dynamic wrapper
 * (`defineDynamic` with the chosen model as the fallback + the playground-directive resolver),
 * so every save makes the agent playground-switchable. Strategy, in order:
 *  1. Retarget the fallback of an existing Eden dynamic wrapper in place.
 *  2. Upgrade a static provider call or plain string literal to the dynamic wrapper.
 *  3. Inject a dynamic `model:` prop into an existing `defineAgent({ ... })`.
 *  4. Scaffold a fresh module.
 */
export function setModel(
  source: string,
  model: string,
  options?: { contextWindowTokens?: number | null },
): string {
  const safe = model.replace(/['"`\\]/g, "");
  const tokens = contextWindow(options);
  // Replace INSIDE the existing wrapper/call first — injecting a second `model:` prop would
  // silently lose (object literals: last prop wins) and fail typecheck (duplicate property).
  if (MODEL_DYNAMIC.test(source) && (FALLBACK_CALL.test(source) || FALLBACK_LITERAL.test(source))) {
    let next = FALLBACK_CALL.test(source)
      ? source.replace(FALLBACK_CALL, (_match, prefix) => {
          return `${prefix}${openRouterModelCallStart(safe)}`;
        })
      : // A user-authored dynamic wrapper with a gateway-string fallback: rewire it to OpenRouter.
        source.replace(FALLBACK_LITERAL, `fallback: ${openRouterModelCall(safe)}`);
    // MODEL_PROP would match only a prefix of the dynamic wrapper, so never append after it —
    // when the tokens prop is missing here, drop it right inside defineAgent({ instead.
    next = MODEL_CONTEXT.test(next)
      ? next.replace(MODEL_CONTEXT, `$1${tokens}`)
      : next.replace(
          DEFINE_AGENT_OPEN,
          (match) => `${match}\n  modelContextWindowTokens: ${tokens},`,
        );
    return withEdenDynamicWiring(withOpenRouterWiring(next));
  }
  if (MODEL_CALL.test(source) || MODEL_LITERAL.test(source)) {
    // Set the context window while the model prop is still static (MODEL_PROP anchors on that
    // shape), then swap the static value for the dynamic wrapper.
    let next = withContextWindow(source, tokens);
    next = MODEL_CALL_FULL.test(next)
      ? next.replace(MODEL_CALL_FULL, (_match, prefix) => `${prefix}${dynamicModelValue(safe)}`)
      : next.replace(MODEL_LITERAL, (_match, prefix) => `${prefix}${dynamicModelValue(safe)}`);
    return withEdenDynamicWiring(withOpenRouterWiring(next));
  }
  if (DEFINE_AGENT_OPEN.test(source)) {
    const next = source.replace(
      DEFINE_AGENT_OPEN,
      (match) =>
        `${match}\n  model: ${dynamicModelValue(safe)},\n  modelContextWindowTokens: ${tokens},`,
    );
    return withEdenDynamicWiring(withOpenRouterWiring(next));
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
  return `${OPENROUTER_IMPORT}import { defineAgent, defineDynamic } from 'eve';\n\n${OPENROUTER_FACTORY}\n${EDEN_MODEL_HELPER}\nexport default defineAgent({\n  model: ${dynamicModelValue(safe)},\n  modelContextWindowTokens: ${tokens},\n});\n`;
}

/**
 * True when a declared eve range GUARANTEES >= 0.22.0 (`defineDynamic`'s first release).
 * Absent specs pass — a team member's package.json may inherit eve from the repo root, and a
 * repo without eve anywhere was never going to build. URL-ish specs (git/file/github forks)
 * pass — they're deliberate user overrides Eden must not clobber (D3). Floating specs
 * ("latest", "*", dist-tags, floorless ranges) FAIL even though npm would resolve them to a
 * modern eve today: agent images build behind a Docker layer cache keyed on package.json
 * bytes, so a floating spec stays frozen at whatever version the first build installed
 * (a prod repo's "latest" was stuck at 0.20.0). Rewriting to EVE_MIN_VERSION both guarantees
 * the API and changes the bytes, which busts the stale install layer.
 */
function eveSupportsDefineDynamic(spec: string | undefined): boolean {
  if (typeof spec !== "string") return true;
  const s = spec.trim();
  if (s.includes(":") || s.includes("/")) return true;
  const floor = s.match(/^(?:>=|[~^=v])?\s*(\d+)(?:\.(\d+))?(?:\.\d+)?(?:[-.].*)?$/);
  if (!floor) return false;
  return Number(floor[1]) > 0 || Number(floor[2] ?? 0) >= 22;
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
  // The generated agent.ts imports `defineDynamic` from eve — a pin below 0.22 can't provide it.
  const eveOk = eveSupportsDefineDynamic(current[EVE_PACKAGE]);
  if (providerOk && !legacyProviderPresent && zodOk && eveOk) {
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
      ...(eveOk ? {} : { [EVE_PACKAGE]: EVE_MIN_VERSION }),
    }).sort(([a], [b]) => a.localeCompare(b)),
  );
  return JSON.stringify({ ...base, dependencies }, null, 2) + "\n";
}
