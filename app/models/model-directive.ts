/**
 * Per-conversation model directive — the transport between the Playground's model selector and
 * a deployed agent's dynamic-model resolver.
 *
 * Eve's session API has no per-turn model field, so the selection travels as one
 * machine-readable HTML-comment line prepended to the SENT message (via `messagePrefix` in
 * `streamTurnResponse`):
 *
 *   <!-- eden:model anthropic/claude-sonnet-5 ctx=200000 -->
 *
 * The deployed agent's `step.started` resolver (emitted by `~/eve/agentModule`) parses the same
 * line to pick the model, and Eden strips it from every display surface. Because the directive
 * is part of the durable `message.received` event, it doubles as the per-turn model record when
 * a transcript is replayed.
 *
 * Attribution: once an agent's `model:` is wrapped in `defineDynamic`, eve reports
 * `session.started → runtime.modelId` as `dynamic:<fallback id>` (verified against vercel/eve
 * `execution/node-step.ts`). `effectiveModelId` folds that prefix and the directive together so
 * both the live path (`~/agent/talk.server`) and replay (`~/playground/sessions.server`) show
 * the model that actually served the turn.
 */

/** Eve prefixes `runtime.modelId` with this when the agent's model is a `defineDynamic`. */
export const DYNAMIC_MODEL_ID_PREFIX = "dynamic:";

export interface ModelDirective {
  /** OpenRouter model id, e.g. "anthropic/claude-sonnet-5". */
  id: string;
  /** Context window of that model when known (from the OpenRouter catalog). */
  contextWindowTokens?: number;
}

/** Must stay in sync with EDEN_MODEL_HELPER in `~/eve/agentModule` (the agent-side parser). */
const DIRECTIVE_RE = /^<!--\s*eden:model\s+(\S+?)(?:\s+ctx=(\d+))?\s*-->/;
const DIRECTIVE_LINE_RE = /^<!--\s*eden:model[^>]*-->[ \t]*\n*/;

/** The one-line directive to prepend to the sent message. */
export function buildModelDirective(directive: ModelDirective): string {
  // The id lands inside an HTML comment and a regex — keep it to safe id characters.
  const id = directive.id.replace(/[^\w./:@-]/g, "");
  const ctx = directive.contextWindowTokens;
  const window =
    typeof ctx === "number" && Number.isFinite(ctx) && ctx > 0
      ? ` ctx=${Math.round(ctx)}`
      : "";
  return `<!-- eden:model ${id}${window} -->`;
}

/** Parse the directive off the front of a sent message, or null when absent/malformed. */
export function parseModelDirective(text: string): ModelDirective | null {
  const match = text.match(DIRECTIVE_RE);
  if (!match) return null;
  return {
    id: match[1],
    contextWindowTokens: match[2] ? Number(match[2]) : undefined,
  };
}

/** Remove the directive line (and the blank line after it) from a message for display. */
export function stripModelDirective(text: string): string {
  return text.replace(DIRECTIVE_LINE_RE, "");
}

/**
 * Eden's generated wiring names its provider "openrouter", and eve formats a live fallback
 * model's id as `<provider>/<modelId>` — so a dynamic agent reports
 * `dynamic:openrouter/anthropic/claude-…`. Strip that provider segment so fallback-served
 * turns display the same bare OpenRouter id directive-served turns do.
 */
const GATEWAY_PROVIDER_PREFIX = "openrouter/";

/** Split eve's reported runtime id into the displayable base id + the dynamic-model flag. */
export function runtimeModelBase(runtimeModelId: string): {
  id: string;
  dynamic: boolean;
} {
  const dynamic = runtimeModelId.startsWith(DYNAMIC_MODEL_ID_PREFIX);
  if (!dynamic) return { id: runtimeModelId, dynamic };
  let id = runtimeModelId.slice(DYNAMIC_MODEL_ID_PREFIX.length);
  if (id.startsWith(GATEWAY_PROVIDER_PREFIX)) {
    id = id.slice(GATEWAY_PROVIDER_PREFIX.length);
  }
  return { id, dynamic };
}

/**
 * The model that actually served a turn, from eve's reported runtime id + the sent message.
 * Static agents report a plain id (directives had no effect — ignore them); dynamic agents
 * report `dynamic:<fallback>`, overridden per turn by the message's directive.
 */
export function effectiveModelId(
  runtimeModelId: string,
  sentMessage: string,
): string {
  const base = runtimeModelBase(runtimeModelId);
  if (!base.dynamic) return base.id;
  return parseModelDirective(sentMessage)?.id ?? base.id;
}
