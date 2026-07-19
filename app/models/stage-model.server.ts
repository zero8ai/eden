/**
 * Model staging shared by Settings' "Model" section and the Playground's "Enable model
 * switching": rewrite the member's `agent.ts` through `setModel` (the chosen model becomes the
 * `defineDynamic` fallback, so the agent honors the playground's per-conversation directive)
 * and keep its `package.json` provider/eve dependencies compatible — both staged as drafts on
 * the normal change-set rails, nothing touches git until the user publishes.
 */
import type { DataStore } from "~/data/ports";
import {
  resolveFileView,
  stageDraft,
  type FileViewDeps,
} from "~/drafts/drafts.server";
import {
  ensureModelProviderDependencies,
  readModel,
  readModelContextWindow,
  readReasoningEffort,
  scaffoldAgentModule,
  setModel,
} from "~/eve/agentModule";
import type { ReasoningEffort } from "~/models/reasoning";
import { packageJsonPathForRoot } from "~/marketplace/install.server";
import {
  findWorkspaceModel,
  listWorkspaceModelCatalog,
} from "~/models/union.server";
import {
  findGatewayBoundSubagents,
  isSubagentAgentPath,
  resolveBareSubagentModel,
  wireSubagentModels,
  type BareSubagentModelResolution,
  type UnresolvedSubagentModel,
} from "~/models/subagent-wiring";
import { getRuntime } from "~/seams/index.server";

export interface StageModelInput {
  project: {
    id: string;
    orgId: string;
    repoInstallationId: string;
    repoOwner: string;
    repoName: string;
  };
  /** The member's agent root, e.g. "agent" or "agents/planner/agent". */
  root: string;
  /** Connected, provider/connection-qualified model ref to use as the fallback. */
  model: string;
  /** Explicit normalized effort; null delegates to the selected provider's default. */
  effort?: ReasoningEffort | null;
  /** Context window to keep when the catalog lookup misses (else `setModel`'s default). */
  fallbackContextWindowTokens?: number | null;
  createdBy: string | null;
}

export type StageModelResult = { ok: true } | { ok: false; error: string };

/** GitHub reads + the model-catalog lookup, injected so unit tests run with zero I/O. */
export interface StageModelDeps extends FileViewDeps {
  lookupModel: typeof findWorkspaceModel;
}

/**
 * Stage the model change for one member: `agent.ts` (dynamic wrapper, `model` as the fallback)
 * plus `package.json` when its dependencies need the OpenRouter provider / eve bump. Re-running
 * with the same model re-stages identical content (draft upsert — idempotent).
 */
export async function stageModelChange(
  input: StageModelInput,
  store: DataStore = getRuntime().data,
  deps?: StageModelDeps,
): Promise<StageModelResult> {
  return stageModelChangeInternal(input, store, deps, true);
}

async function stageModelChangeInternal(
  input: StageModelInput,
  store: DataStore,
  deps: StageModelDeps | undefined,
  validateSelection: boolean,
): Promise<StageModelResult> {
  const modelInfo = await (deps?.lookupModel ?? findWorkspaceModel)(
    input.project.orgId,
    input.model,
  );
  if (validateSelection && !modelInfo) {
    return {
      ok: false,
      error:
        "That model is not available from an active provider connection in this workspace.",
    };
  }
  if (
    validateSelection &&
    input.effort &&
    !modelInfo?.supportedEfforts?.includes(input.effort)
  ) {
    return {
      ok: false,
      error: "That reasoning effort is not supported by the selected model.",
    };
  }
  const contextWindowTokens =
    modelInfo?.contextWindow ?? input.fallbackContextWindowTokens;
  const path = `${input.root}/agent.ts`;
  const view = await resolveFileView(input.project, path, store, deps);
  const next = view.content
    ? setModel(view.content, input.model, {
        contextWindowTokens,
        effort: input.effort,
      })
    : scaffoldAgentModule(input.model, {
        contextWindowTokens,
        effort: input.effort,
      });

  const pkgPath = packageJsonPathForRoot(input.root);
  const pkgView = await resolveFileView(input.project, pkgPath, store, deps);
  let packageJson: string;
  try {
    packageJson = ensureModelProviderDependencies(pkgView.content);
  } catch {
    return {
      ok: false,
      error: `${pkgPath} is not valid JSON — fix it before setting the model.`,
    };
  }

  await Promise.all([
    stageDraft(
      {
        projectId: input.project.id,
        path,
        content: next,
        createdBy: input.createdBy,
      },
      store,
    ),
    packageJson !== pkgView.content
      ? stageDraft(
          {
            projectId: input.project.id,
            path: pkgPath,
            content: packageJson,
            createdBy: input.createdBy,
          },
          store,
        )
      : Promise.resolve(),
  ]);
  return { ok: true };
}

/** GitHub reads plus the workspace-catalog loader that qualifies bare subagent ids. */
export interface SubagentWiringDeps extends FileViewDeps {
  /** Injected in tests; defaults to the real workspace catalog. */
  loadCatalog?: typeof listWorkspaceModelCatalog;
}

/**
 * Auto-wire a member's subagents (issue: subagents ship bare gateway-bound models). For each
 * `<memberRoot>/subagents/<name>/agent.ts` whose model is a bare literal that eve would route to
 * the unprovisioned model gateway, re-stage it through the same dynamic wrapper the member gets so
 * it resolves through the workspace's connected providers instead. Only `agent.ts` is staged —
 * subagents share the member's `package.json`, which already carries the provider deps once the
 * member is wired. `candidatePaths` is the member's known repo paths (the caller already holds the
 * source); staged DRAFT paths under the member are considered too, so a subagent that exists only
 * as a draft (created in the editor, blocked by the publish gate, never committed) is wired by the
 * same model save instead of dead-ending. Non-subagent paths and paths outside `memberRoot` are
 * ignored. Idempotent: a subagent that's already wired stages nothing.
 *
 * Each bare id is qualified against the workspace catalog (issue #198): mapped unambiguously to
 * an active connection it becomes a `provider/connectionId/id` ref that `edenModel` runs on that
 * exact connection's credential — instead of the generic OpenRouter alias, which doesn't exist on
 * an Anthropic/OpenAI/Codex-only workspace. A model no active connection can run is left
 * un-wired and reported in `unresolved` so the caller surfaces a save-time hint (the publish gate
 * keeps blocking it). A catalog outage falls open to the pre-qualification alias wiring.
 */
export async function stageSubagentModelWiring(
  input: {
    project: StageModelInput["project"];
    /** The member's agent root, e.g. "agents/bookkeeping/agent". */
    memberRoot: string;
    /** Repo paths the caller already loaded (e.g. `source.paths`). */
    candidatePaths: string[];
    createdBy: string | null;
  },
  store: DataStore = getRuntime().data,
  deps?: SubagentWiringDeps,
): Promise<{ wired: string[]; unresolved: UnresolvedSubagentModel[] }> {
  const prefix = `${input.memberRoot}/subagents/`;
  const drafts = await store.drafts.listByProject(input.project.id);
  // A deletion draft's view falls back to the REPO content, so wiring such a path would stage new
  // content on top of the deletion — silently un-deleting the subagent. Leave those alone.
  const deletions = new Set(
    drafts.filter((d) => d.content === null).map((d) => d.path),
  );
  const subagentPaths = [
    ...new Set(
      [...input.candidatePaths, ...drafts.map((d) => d.path)].filter(
        (p) =>
          p.startsWith(prefix) && isSubagentAgentPath(p) && !deletions.has(p),
      ),
    ),
  ];
  if (subagentPaths.length === 0) return { wired: [], unresolved: [] };

  const files: Record<string, string | null> = {};
  await Promise.all(
    subagentPaths.map(async (path) => {
      const view = await resolveFileView(input.project, path, store, deps);
      files[path] = view.content;
    }),
  );
  if (findGatewayBoundSubagents(files).length === 0) {
    return { wired: [], unresolved: [] };
  }

  // Provider catalogs are only worth fetching once an offender exists (above). A load failure
  // must not strand the save: fall open to the alias wiring — exactly the pre-#198 behavior.
  let resolve: ((model: string) => BareSubagentModelResolution) | undefined;
  try {
    const catalog = await (deps?.loadCatalog ?? listWorkspaceModelCatalog)(
      input.project.orgId,
    );
    const openRouterCatalogUnavailable = catalog.unavailable.some(
      (u) => u.provider === "openrouter",
    );
    resolve = (model) =>
      resolveBareSubagentModel(model, catalog.models, {
        openRouterCatalogUnavailable,
      });
  } catch {
    resolve = undefined;
  }

  const { changed, unresolved } = wireSubagentModels(files, resolve);
  await Promise.all(
    changed.map((c) =>
      stageDraft(
        {
          projectId: input.project.id,
          path: c.path,
          content: c.content,
          createdBy: input.createdBy,
        },
        store,
      ),
    ),
  );
  return { wired: changed.map((c) => c.path), unresolved };
}

/**
 * Make a member playground-switchable WITHOUT changing its model: re-stage the CURRENT model
 * through the dynamic wrapper. This is the Playground's "Enable model switching" — the fix for
 * agents whose deployed `agent.ts` predates the wrapper (e.g. imported from the catalog) and
 * therefore ignores the per-conversation directive.
 */
export async function stageModelSwitchingUpgrade(
  input: Omit<StageModelInput, "model">,
  store: DataStore = getRuntime().data,
  deps?: StageModelDeps,
): Promise<StageModelResult> {
  const view = await resolveFileView(
    input.project,
    `${input.root}/agent.ts`,
    store,
    deps,
  );
  const current = view.content ? readModel(view.content) : null;
  if (!view.content || !current) {
    return {
      ok: false,
      error:
        "Couldn't read this agent's current model from agent.ts — set a model in Settings instead.",
    };
  }
  return stageModelChangeInternal(
    {
      ...input,
      model: current,
      // "No model change" includes the context window — keep the module's declared value
      // when the catalog can't confirm one.
      fallbackContextWindowTokens: readModelContextWindow(view.content),
      effort: readReasoningEffort(view.content),
    },
    store,
    deps,
    false,
  );
}
