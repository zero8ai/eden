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
  scaffoldAgentModule,
  setModel,
} from "~/eve/agentModule";
import { packageJsonPathForRoot } from "~/marketplace/install.server";
import { findWorkspaceModel } from "~/models/union.server";
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
  const contextWindowTokens =
    modelInfo?.contextWindow ?? input.fallbackContextWindowTokens;
  const path = `${input.root}/agent.ts`;
  const view = await resolveFileView(input.project, path, store, deps);
  const next = view.content
    ? setModel(view.content, input.model, { contextWindowTokens })
    : scaffoldAgentModule(input.model, { contextWindowTokens });

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
    },
    store,
    deps,
    false,
  );
}
