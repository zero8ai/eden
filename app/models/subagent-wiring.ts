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
 * Rewrite each gateway-bound subagent `agent.ts` so its CURRENT model routes through the same
 * Eden dynamic wrapper the member gets (`setModel` preserves the chosen model, context window, and
 * effort — it only changes how the model is resolved). Returns only the files that changed.
 */
export function wireSubagentModels(
  files: Record<string, string | null | undefined>,
): { path: string; content: string }[] {
  const changed: { path: string; content: string }[] = [];
  for (const { path, model } of findGatewayBoundSubagents(files)) {
    // A template literal with interpolation (`model: \`x/${v}\``) can't be rewritten statically —
    // setModel would freeze the interpolation into a literal string. Leave it for the gate.
    if (model.includes("${")) continue;
    const source = files[path]!;
    const next = setModel(source, model, {
      contextWindowTokens: readModelContextWindow(source),
      effort: readReasoningEffort(source),
    });
    if (next !== source) changed.push({ path, content: next });
  }
  return changed;
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
    `connected providers), or remove the \`model:\` line so the subagent inherits the parent ` +
    `agent, then try again.`
  );
}
