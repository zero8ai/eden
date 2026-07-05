/**
 * Deploy controller + release registry (Deploy pillar, M2 — PRD §7.4/§7.7, ARCH §3.1/§3.9).
 *
 * Orchestrates the pipeline over the seams: cut an immutable Release (merge commit +
 * content-addressed image), deploy it to an environment — a clean cutover that demotes the
 * previously live version once the new one is healthy — and fast-rollback by re-pointing to a
 * prior Release. The weighted traffic split (setTrafficSplit + the ingress splitter) stays in
 * the data model for later, but the product model is one live Release per environment.
 *
 * Persistence goes through the `DataStore` seam (data/ports.ts) and infra through the
 * DeployTarget/SecretsProvider seams, all injected with `getRuntime()` defaults — so every
 * function here is unit-testable against in-memory fakes with no database or docker.
 *
 * The DeployTarget's build/deploy need the eve+docker toolchain; where it's unavailable the
 * controller still records the Release + deployment rows and marks the deployment `failed` with
 * the tooling error, so the control plane and UI work end-to-end without real infra.
 */
import type { DataStore, Deployment, Release } from "~/data/ports";
import { enqueue } from "~/jobs/queue.server";
import { getRuntime } from "~/seams/index.server";
import type { DeployTarget, SecretsProvider } from "~/seams/types";
import { isVersionLabelCollision, versionLabel } from "./versioning";

export type { Release, Deployment } from "~/data/ports";

/** Everything deployRelease/rollbackTo touch: persistence + the two infra seams. */
export interface DeployDeps {
  store: DataStore;
  deployTarget: DeployTarget;
  secrets: SecretsProvider;
  /** Org-level OpenRouter key lookup used by the authoring assistant and deployed agents. */
  workspaceModelKey?: (orgId: string) => Promise<string | null>;
}

function deployDeps(): DeployDeps {
  const r = getRuntime();
  return {
    store: r.data,
    deployTarget: r.deployTarget,
    secrets: r.secrets,
    workspaceModelKey: (orgId) =>
      import("~/org/workspace.server").then((m) => m.getWorkspaceModelKey(orgId)),
  };
}

function deploymentStillActive(status: string): boolean {
  return status === "live" || status === "starting" || status === "pending";
}

async function stopDeploymentInfra(
  deployTarget: DeployTarget,
  deploymentId: string,
): Promise<void> {
  try {
    await deployTarget.stop(deploymentId);
  } catch (stopError) {
    if (!deployTarget.destroy) throw stopError;
    await deployTarget.destroy(deploymentId);
  }

  const health = await deployTarget.health(deploymentId);
  if (!deploymentStillActive(health.status)) return;

  if (deployTarget.destroy) {
    await deployTarget.destroy(deploymentId);
    const afterDestroy = await deployTarget.health(deploymentId);
    if (!deploymentStillActive(afterDestroy.status)) return;
    throw new Error(
      `deployment ${deploymentId} is still ${afterDestroy.status} after destroy`,
    );
  }

  throw new Error(`deployment ${deploymentId} is still ${health.status} after stop`);
}

async function cleanupNewDeploymentInfra(
  deployTarget: DeployTarget,
  deploymentId: string,
): Promise<string | null> {
  try {
    await stopDeploymentInfra(deployTarget, deploymentId);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Record an immutable Release for an agent at a git commit. Image is built lazily at deploy
 * time (imageRef stays null until then). Concurrent creates (e.g. two webhook deliveries) race
 * on the version label; the (agent, version) unique constraint catches it and we retry with a
 * fresh count.
 */
export async function createRelease(
  input: {
    projectId: string;
    agentId: string;
    gitSha: string;
    changelog?: string | null;
    createdBy?: string | null;
  },
  store: DataStore = getRuntime().data,
): Promise<Release> {
  // Each attempt depends on the previous one failing (fresh count after a collision), so
  // retries recurse rather than loop. N concurrent creates resolve one winner per round —
  // allow N-ish rounds.
  const attempt = async (round: number): Promise<Release> => {
    const count = await store.releases.countByAgent(input.agentId);
    try {
      return await store.releases.insert({ ...input, version: versionLabel(count) });
    } catch (err) {
      if (!isVersionLabelCollision(err) || round >= 8) throw err;
      return attempt(round + 1);
    }
  };
  return attempt(0);
}

/**
 * Find-or-create the Release for a merge commit (D9: the merge SHA is the version identity).
 * Idempotent per (agent, gitSha) so the two merge triggers — the in-app Merge button and the
 * GitHub webhook — converge on one Release no matter which fires first (or if both do). Returns
 * whether this call created it, so a caller can act (e.g. audit) only on first creation.
 */
export async function ensureReleaseForCommit(
  input: {
    projectId: string;
    agentId: string;
    gitSha: string;
    changelog?: string | null;
    createdBy?: string | null;
  },
  store: DataStore = getRuntime().data,
): Promise<{ release: Release; created: boolean }> {
  const existing = await store.releases.findByCommit(input.agentId, input.gitSha);
  if (existing) return { release: existing, created: false };
  const release = await createRelease(input, store);
  return { release, created: true };
}

/**
 * Cut Releases for EVERY roster member at a merge commit (a team merge is atomic across
 * members — PRD §7.9; per-member change detection is a later optimization, PRD §12).
 */
export async function ensureReleasesForCommit(
  input: {
    projectId: string;
    gitSha: string;
    changelog?: string | null;
    createdBy?: string | null;
  },
  store: DataStore = getRuntime().data,
): Promise<{ release: Release; created: boolean }[]> {
  const roster = await store.agents.listByProject(input.projectId);
  return Promise.all(
    roster.map((agent) =>
      ensureReleaseForCommit({ ...input, agentId: agent.id }, store),
    ),
  );
}

/** Deployments for an environment, newest first, joined to their release version. */
export function listDeployments(environmentId: string, store: DataStore = getRuntime().data) {
  return store.deployments.listByEnvironment(environmentId);
}

/**
 * Deploy a Release to an environment: build the image if needed, run it via the DeployTarget,
 * and record a deployment row with the resulting health/status. Injects the environment's
 * resolved secrets as container env at start.
 */
export async function deployRelease(
  input: {
    environmentId: string;
    releaseId: string;
    /** Existing `queued` row to take over (from queueDeploy); otherwise one is created. */
    deploymentId?: string;
    /** Force a fresh image build even when the Release already has an imageRef. */
    rebuild?: boolean;
    trafficWeight?: number;
    createdBy?: string | null;
  },
  deps: DeployDeps = deployDeps(),
): Promise<Deployment> {
  const { store, deployTarget, secrets } = deps;
  // Release and environment lookups are independent — fetch them together.
  const [release, env] = await Promise.all([
    store.releases.findById(input.releaseId),
    store.environments.findById(input.environmentId),
  ]);
  if (!release) throw new Error("Release not found.");
  if (!env) throw new Error("Environment not found.");
  // The project/agent lookups and the building-row upsert don't depend on each other.
  const [project, agent, dep] = await Promise.all([
    store.projects.findById(release.projectId),
    store.agents.findById(release.agentId),
    input.deploymentId
      ? store.deployments.update(input.deploymentId, {
          status: "building",
          trafficWeight: input.trafficWeight ?? 100,
        })
      : store.deployments.insert({
          environmentId: input.environmentId,
          releaseId: input.releaseId,
          status: "building",
          trafficWeight: input.trafficWeight ?? 100,
          createdBy: input.createdBy ?? null,
        }),
  ]);

  try {
    let imageRef = release.imageRef;
    const shouldBuild = input.rebuild || !imageRef;
    if (shouldBuild) {
      if (!project?.repoOwner || !project.repoName) {
        throw new Error("Cannot build release: project is not connected to a GitHub repo.");
      }
      const built = await deployTarget.build({
        projectId: release.projectId,
        repo: { owner: project.repoOwner, repo: project.repoName },
        ref: release.gitSha,
        installationId: project.repoInstallationId,
        agentRoot: agent?.root,
      });
      imageRef = built.imageRef;
      await store.releases.setImageRef(release.id, built.imageRef);
    }

    const envVars = await secrets.resolve({
      projectId: release.projectId,
      agentId: release.agentId,
      environmentId: input.environmentId,
    });
    // Legacy/plain Eve model strings call Vercel AI Gateway. Eden-authored model choices use
    // OpenRouter wiring, but keep this fallback so older repos still run if configured.
    for (const key of ["AI_GATEWAY_API_KEY", "VERCEL_OIDC_TOKEN"] as const) {
      const value = process.env[key];
      if (!envVars[key] && value) envVars[key] = value;
    }

    // Eden's primary model path: OpenRouter key inherited from the workspace unless an
    // agent/environment secret explicitly overrides it.
    if (!envVars.OPENROUTER_API_KEY && project && deps.workspaceModelKey) {
      const wsKey = await deps.workspaceModelKey(project.orgId);
      if (wsKey) envVars.OPENROUTER_API_KEY = wsKey;
    }
    const health = await deployTarget.deploy({
      deploymentId: dep.id,
      imageRef: imageRef ?? "",
      env: envVars,
      // World database is keyed by ENVIRONMENT, not deployment: every deploy of this env
      // reuses one world, so sessions and their sandboxes survive redeploys.
      worldKey: env.id,
    });

    if (health.status !== "live") {
      const cleanupError = await cleanupNewDeploymentInfra(deployTarget, dep.id);
      return store.deployments.update(dep.id, {
        status: health.status,
        url: health.url ?? null,
        errorDetail:
          health.status === "failed"
            ? [health.detail, cleanupError && `cleanup failed: ${cleanupError}`]
                .filter(Boolean)
                .join("; ") || null
            : cleanupError
              ? `cleanup failed: ${cleanupError}`
              : null,
      });
    }

    // Cutover: a deployment that lands live becomes THE live version of this environment.
    // Every other live deployment — any release — is demoted (stopped, weight 0). The old
    // version keeps serving until this moment, so a failed deploy never takes anything down.
    // (The weighted multi-version splitter survives in the data model, but the product model
    // is single-live-per-environment for now.)
    const siblings = await store.deployments.listByEnvironment(input.environmentId);
    const superseded = siblings.filter((d) => d.id !== dep.id && d.status === "live");
    try {
      await Promise.all(
        superseded.map(async (d) => {
          await stopDeploymentInfra(deployTarget, d.id);
          await store.deployments.update(d.id, {
            status: "stopped",
            trafficWeight: 0,
            errorDetail: null,
          });
        }),
      );
    } catch (error) {
      const cleanupError = await cleanupNewDeploymentInfra(deployTarget, dep.id);
      const detail = error instanceof Error ? error.message : String(error);
      return store.deployments.update(dep.id, {
        status: "failed",
        url: health.url ?? null,
        errorDetail: [
          `cutover failed while stopping the previous deployment: ${detail}`,
          cleanupError && `new deployment cleanup failed: ${cleanupError}`,
        ]
          .filter(Boolean)
          .join("; "),
      });
    }

    const updated = await store.deployments.update(dep.id, {
      status: health.status,
      url: health.url ?? null,
      errorDetail: null,
    });
    if (project) {
      await store.audit.record({
        orgId: project.orgId,
        actorUserId: input.createdBy ?? null,
        action: "deploy",
        target: release.version,
        meta: { environmentId: input.environmentId, status: updated.status },
      });
    }
    return updated;
  } catch (error) {
    await cleanupNewDeploymentInfra(deployTarget, dep.id);
    // Record WHY it failed — a bare `failed` row is undebuggable (and while the eve
    // toolchain is young, build failures are the expected failure mode).
    const detail = error instanceof Error ? error.message : String(error);
    return store.deployments.update(dep.id, { status: "failed", errorDetail: detail });
  }
}

/**
 * Fast rollback (D9): deploy a prior Release again at full weight. The prior image is reused
 * (no rebuild) when it's already been built, and deployRelease's cutover demotes the current
 * version only once the rollback is actually live — a failed rollback leaves it serving.
 */
export async function rollbackTo(
  input: {
    environmentId: string;
    releaseId: string;
    deploymentId?: string;
    createdBy?: string | null;
  },
  deps: DeployDeps = deployDeps(),
): Promise<Deployment> {
  return deployRelease({ ...input, trafficWeight: 100 }, deps);
}

/**
 * Queue a deploy (or rollback) the way the UI needs it: create the deployment row in `queued`
 * status FIRST — so the click has an immediately-visible result — then enqueue the job that
 * takes the row through building → live/failed. Without this, the row only appeared when the
 * worker picked the job up, which read as "the button did nothing".
 */
export async function queueDeploy(
  input: {
    environmentId: string;
    releaseId: string;
    rollback?: boolean;
    rebuild?: boolean;
    createdBy?: string | null;
  },
  store: DataStore = getRuntime().data,
): Promise<Deployment> {
  const dep = await store.deployments.insert({
    environmentId: input.environmentId,
    releaseId: input.releaseId,
    status: "queued",
    trafficWeight: 100,
    createdBy: input.createdBy ?? null,
  });
  await enqueue(
    input.rollback ? "rollback_release" : "deploy_release",
    {
      environmentId: input.environmentId,
      releaseId: input.releaseId,
      deploymentId: dep.id,
      rebuild: input.rebuild ?? false,
      createdBy: input.createdBy ?? null,
    },
    undefined,
    store,
  );
  return dep;
}

/**
 * Set the weighted, session-sticky traffic split across an environment's deployments (D9/D10).
 * Weights are relative integers the ingress splitter normalizes; the human decides them.
 */
export async function setTrafficSplit(
  environmentId: string,
  weights: { deploymentId: string; weight: number }[],
  store: DataStore = getRuntime().data,
): Promise<void> {
  await store.deployments.setWeights(environmentId, weights);
}

/** Remove an environment's failed deployment rows (post-mortem clutter in the UI). */
export function clearFailedDeployments(
  environmentId: string,
  store: DataStore = getRuntime().data,
): Promise<void> {
  return store.deployments.deleteFailed(environmentId);
}

/** Find the project connected to a repo (for webhook-driven deploys). */
export function findProjectByRepo(
  owner: string,
  repo: string,
  store: DataStore = getRuntime().data,
) {
  return store.projects.findByRepo(owner, repo);
}
