/**
 * Subagent model wiring (pure) — the systemic fix for subagents that ship a bare model literal.
 *
 * Eden's model tooling (`stageModelChange` / `setModel`) only ever rewrites a MEMBER root's
 * `agent.ts`, giving it the `defineDynamic(edenModel(...))` router that resolves through the
 * workspace's connected providers (OpenRouter / Codex gateway) and honors the playground's
 * per-conversation model directive. A subagent lives at `<memberRoot>/subagents/<name>/agent.ts`
 * and is NEVER touched by that path, so a hand- or assistant-authored subagent can carry a bare
 * `model: 'anthropic/claude-sonnet-5'` — which eve resolves through the Vercel AI Gateway that
 * Eden deliberately doesn't provision. At runtime the subagent dies with "missing AI Gateway
 * credentials … run `eve link`". These helpers detect and auto-wire that shape so the subagent
 * routes exactly like its member; the guard blocks it from being introduced in the first place.
 *
 * Pure (no I/O) so both the publish/merge gates and unit tests use them directly.
 */
import {
  bareGatewayModel,
  readModelContextWindow,
  readReasoningEffort,
  setModel,
} from "~/eve/agentModule";
import type { ModelCatalogEntry } from "~/models/catalog.server";

/** A subagent entrypoint: `.../subagents/<name>/agent.ts`, at any member-root depth. */
const SUBAGENT_AGENT_PATH = /(^|\/)subagents\/[^/]+\/agent\.ts$/;

export function isSubagentAgentPath(path: string): boolean {
  return SUBAGENT_AGENT_PATH.test(path);
}

export interface GatewayBoundSubagent {
  /** Repo-relative path of the offending subagent `agent.ts`. */
  path: string;
  /** The bare model literal that would route to the unprovisioned gateway. */
  model: string;
}

/**
 * Every subagent `agent.ts` in `files` whose model is a bare gateway-bound literal. `files` is a
 * path→content map (a null content — a deletion draft — is skipped). Only subagents are checked:
 * member roots always get the wrapper from the model tooling.
 */
export function findGatewayBoundSubagents(
  files: Record<string, string | null | undefined>,
): GatewayBoundSubagent[] {
  const out: GatewayBoundSubagent[] = [];
  for (const [path, content] of Object.entries(files)) {
    if (content == null || !isSubagentAgentPath(path)) continue;
    const model = bareGatewayModel(content);
    if (model) out.push({ path, model });
  }
  return out;
}

/**
 * How a subagent's bare model literal maps onto the workspace's provider connections. `edenModel`
 * resolves a QUALIFIED `provider/connectionId/id` ref with that exact connection's credential, but
 * a bare id falls to the generic OpenRouter alias — which only exists when the org has an active
 * OpenRouter connection. Qualifying at wire time is what makes a subagent runnable on
 * Anthropic/OpenAI/Codex-only workspaces.
 */
export type BareSubagentModelResolution =
  /** Exactly one active connection carries the model — write the qualified ref. */
  | { kind: "qualified"; model: string; contextWindowTokens: number | null }
  /** Keep the bare literal: the workspace's OpenRouter alias credential runs it. */
  | { kind: "alias" }
  /** No active connection can run it (or Eden can't pick one) — leave it for the save-time hint. */
  | { kind: "unresolvable"; reason: "ambiguous" | "no-connection" };

/** A catalog entry as the resolver consumes it (the qualified workspace-catalog shape). */
type QualifiedCatalogEntry = Pick<
  ModelCatalogEntry,
  "id" | "provider" | "upstreamModelId" | "contextWindow"
>;

/**
 * Resolve a subagent's bare model id against the workspace catalog. A bare id is gateway/
 * OpenRouter-shaped (`creator/model`, e.g. `anthropic/claude-sonnet-5`); a workspace entry matches
 * when it IS that id on an OpenRouter connection, or when the creator segment names the entry's
 * provider and the tail is its upstream id (`anthropic/claude-sonnet-5` ↔ an Anthropic
 * connection's `claude-sonnet-5`; Codex models surface under the `openai/` creator).
 *
 * Exactly one matching connection → qualified ref. Several → the sole OpenRouter match wins when
 * there is one (a bare id already routes to OpenRouter today, so that preserves the routing while
 * pinning the exact connection credential); otherwise the id is ambiguous. No match → nothing can
 * run it, unless OpenRouter's catalog couldn't be listed (`openRouterCatalogUnavailable`) — then
 * fail open to the alias rather than block on a provider outage.
 */
export function resolveBareSubagentModel(
  model: string,
  catalog: QualifiedCatalogEntry[],
  options: { openRouterCatalogUnavailable: boolean },
): BareSubagentModelResolution {
  const matches = new Map<string, QualifiedCatalogEntry>();
  for (const entry of catalog) {
    if (!entry.provider || !entry.upstreamModelId) continue;
    const creator = entry.provider === "codex" ? "openai" : entry.provider;
    const matched =
      entry.provider === "openrouter"
        ? entry.upstreamModelId === model
        : model === `${creator}/${entry.upstreamModelId}`;
    if (matched) matches.set(entry.id, entry);
  }
  const qualified = (entry: QualifiedCatalogEntry) =>
    ({
      kind: "qualified",
      model: entry.id,
      contextWindowTokens: entry.contextWindow ?? null,
    }) as const;
  const all = [...matches.values()];
  if (all.length === 1) return qualified(all[0]!);
  if (all.length > 1) {
    const openRouter = all.filter((e) => e.provider === "openrouter");
    if (openRouter.length === 1) return qualified(openRouter[0]!);
    // Several OpenRouter connections carry it: the alias (input-order default credential) already
    // runs the bare id — keep the status quo rather than guess a connection.
    if (openRouter.length > 1) return { kind: "alias" };
    return { kind: "unresolvable", reason: "ambiguous" };
  }
  if (options.openRouterCatalogUnavailable) return { kind: "alias" };
  return { kind: "unresolvable", reason: "no-connection" };
}

/** A subagent left un-wired because its model resolves to no runnable connection. */
export interface UnresolvedSubagentModel {
  path: string;
  model: string;
  reason: "ambiguous" | "no-connection";
}

export interface WireSubagentModelsResult {
  changed: { path: string; content: string }[];
  unresolved: UnresolvedSubagentModel[];
}

/**
 * Rewrite each gateway-bound subagent `agent.ts` so its model routes through the same Eden
 * dynamic wrapper the member gets. `resolve` (built from the workspace catalog) qualifies the
 * bare id against an active connection: a qualified ref runs on that exact connection's
 * credential; an `alias` resolution (or no resolver) keeps the bare literal, which runs on the
 * OpenRouter alias; an `unresolvable` model is left untouched and reported so the caller can
 * surface a save-time hint instead of silently wiring a ref that can't run.
 */
export function wireSubagentModels(
  files: Record<string, string | null | undefined>,
  resolve?: (model: string) => BareSubagentModelResolution,
): WireSubagentModelsResult {
  const changed: { path: string; content: string }[] = [];
  const unresolved: UnresolvedSubagentModel[] = [];
  for (const { path, model } of findGatewayBoundSubagents(files)) {
    // A template literal with interpolation (`model: \`x/${v}\``) can't be rewritten statically —
    // setModel would freeze the interpolation into a literal string. Leave it for the gate.
    if (model.includes("${")) continue;
    const resolution = resolve?.(model) ?? { kind: "alias" as const };
    if (resolution.kind === "unresolvable") {
      unresolved.push({ path, model, reason: resolution.reason });
      continue;
    }
    const source = files[path]!;
    const target = resolution.kind === "qualified" ? resolution.model : model;
    const contextWindowTokens =
      (resolution.kind === "qualified"
        ? resolution.contextWindowTokens
        : null) ?? readModelContextWindow(source);
    const next = setModel(source, target, {
      contextWindowTokens,
      effort: readReasoningEffort(source),
    });
    if (next !== source) changed.push({ path, content: next });
  }
  return { changed, unresolved };
}

/**
 * Save-time hint for subagents the auto-wire had to leave alone. Actionable at the moment the
 * member's model is saved — the alternative is a runtime credential failure (or a publish-gate
 * block whose generic wording doesn't say WHY re-saving didn't fix the subagent).
 */
export function unresolvedSubagentModelError(
  unresolved: UnresolvedSubagentModel[],
): string {
  const lines = unresolved
    .map(
      (u) =>
        `- \`${u.path}\` → \`model: "${u.model}"\` ${
          u.reason === "ambiguous"
            ? "(several connections offer this model — Eden can't pick one)"
            : "(no active provider connection offers this model)"
        }`,
    )
    .join("\n");
  const one = unresolved.length === 1;
  return (
    `${unresolved.length} subagent model${one ? "" : "s"} couldn't be routed through this ` +
    `workspace's provider connections:\n\n${lines}\n\n` +
    `Connect a provider that offers ${one ? "the" : "each"} model (or an OpenRouter connection), ` +
    `then re-save the agent's model in Settings → Model — or edit the subagent's \`model:\` line. ` +
    `Publishing stays blocked until ${one ? "it is" : "they are"} routed.`
  );
}

/**
 * Human-readable block message for the publish/merge gate. Names each offending subagent and what
 * to do — the same wording in both gates so the two never drift.
 */
export function gatewayBoundSubagentError(
  offenders: GatewayBoundSubagent[],
): string {
  const lines = offenders
    .map((o) => `- \`${o.path}\` → \`model: "${o.model}"\``)
    .join("\n");
  const plural = offenders.length === 1 ? "" : "s";
  const one = offenders.length === 1;
  return (
    `${offenders.length} subagent${plural} pin${one ? "s" : ""} a model that routes to the model gateway ` +
    `Eden doesn't provision, so ${one ? "it" : "they"} would fail at runtime with ` +
    `"missing AI Gateway credentials":\n\n${lines}\n\n` +
    `Re-save the agent's model in Settings → Model (Eden re-wires its subagents through your ` +
    `connected providers — connect a provider that offers the model first if none does), or ` +
    `remove the \`model:\` line so the subagent inherits the parent agent, then try again.`
  );
}
