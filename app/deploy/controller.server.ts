/**
 * Deploy controller + release registry (Deploy pillar, M2 — PRD §7.4/§7.7, ARCH §3.1/§3.9).
 *
 * Orchestrates the pipeline over the seams: cut an immutable Release (merge commit +
 * content-addressed image), deploy it to an environment as a weighted deployment, fast-rollback
 * by re-pointing to a prior Release, and set the session-sticky traffic split across
 * concurrently-live Releases.
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
import { getRuntime } from "~/seams/index.server";
import type { DeployTarget, SecretsProvider } from "~/seams/types";
import { isVersionLabelCollision, versionLabel } from "./versioning";

export type { Release, Deployment } from "~/data/ports";

/** Everything deployRelease/rollbackTo touch: persistence + the two infra seams. */
export interface DeployDeps {
  store: DataStore;
  deployTarget: DeployTarget;
  secrets: SecretsProvider;
}

function deployDeps(): DeployDeps {
  const r = getRuntime();
  return { store: r.data, deployTarget: r.deployTarget, secrets: r.secrets };
}

/**
 * Record an immutable Release for a project at a git commit. Image is built lazily at deploy
 * time (imageRef stays null until then). Concurrent creates (e.g. two webhook deliveries) race
 * on the version label; the (project, version) unique constraint catches it and we retry with a
 * fresh count.
 */
export async function createRelease(
  input: {
    projectId: string;
    gitSha: string;
    changelog?: string | null;
    createdBy?: string | null;
  },
  store: DataStore = getRuntime().data,
): Promise<Release> {
  for (let attempt = 0; ; attempt++) {
    const count = await store.releases.countByProject(input.projectId);
    const version = versionLabel(count);
    try {
      return await store.releases.insert({ ...input, version });
    } catch (err) {
      // N concurrent creates resolve one winner per round — allow N-ish rounds.
      if (!isVersionLabelCollision(err) || attempt >= 8) throw err;
    }
  }
}

/**
 * Find-or-create the Release for a merge commit (D9: the merge SHA is the version identity).
 * Idempotent per (project, gitSha) so the two merge triggers — the in-app Merge button and the
 * GitHub webhook — converge on one Release no matter which fires first (or if both do). Returns
 * whether this call created it, so a caller can act (e.g. audit) only on first creation.
 */
export async function ensureReleaseForCommit(
  input: {
    projectId: string;
    gitSha: string;
    changelog?: string | null;
    createdBy?: string | null;
  },
  store: DataStore = getRuntime().data,
): Promise<{ release: Release; created: boolean }> {
  const existing = await store.releases.findByCommit(input.projectId, input.gitSha);
  if (existing) return { release: existing, created: false };
  const release = await createRelease(input, store);
  return { release, created: true };
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
    trafficWeight?: number;
    createdBy?: string | null;
  },
  deps: DeployDeps = deployDeps(),
): Promise<Deployment> {
  const { store, deployTarget, secrets } = deps;
  const release = await store.releases.findById(input.releaseId);
  if (!release) throw new Error("Release not found.");
  const env = await store.environments.findById(input.environmentId);
  if (!env) throw new Error("Environment not found.");
  const project = await store.projects.findById(release.projectId);

  const dep = await store.deployments.insert({
    environmentId: input.environmentId,
    releaseId: input.releaseId,
    status: "building",
    trafficWeight: input.trafficWeight ?? 100,
    createdBy: input.createdBy ?? null,
  });

  try {
    let imageRef = release.imageRef;
    if (!imageRef && project?.repoOwner && project.repoName) {
      const built = await deployTarget.build({
        projectId: release.projectId,
        repo: { owner: project.repoOwner, repo: project.repoName },
        ref: release.gitSha,
        installationId: project.repoInstallationId,
      });
      imageRef = built.imageRef;
      await store.releases.setImageRef(release.id, built.imageRef);
    }

    const envVars = await secrets.resolve(release.projectId, input.environmentId);
    const health = await deployTarget.deploy({
      deploymentId: dep.id,
      imageRef: imageRef ?? "",
      env: envVars,
    });
    const updated = await store.deployments.update(dep.id, {
      status: health.status,
      url: health.url ?? null,
      errorDetail: health.status === "failed" ? (health.detail ?? null) : null,
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
    // Record WHY it failed — a bare `failed` row is undebuggable (and while the eve
    // toolchain is young, build failures are the expected failure mode).
    const detail = error instanceof Error ? error.message : String(error);
    return store.deployments.update(dep.id, { status: "failed", errorDetail: detail });
  }
}

/**
 * Fast rollback (D9): deploy a prior Release again at full weight and drain the others in the
 * environment. The prior image is reused (no rebuild) when it's already been built.
 */
export async function rollbackTo(
  input: { environmentId: string; releaseId: string; createdBy?: string | null },
  deps: DeployDeps = deployDeps(),
): Promise<Deployment> {
  await deps.store.deployments.drainLive(input.environmentId);
  return deployRelease({ ...input, trafficWeight: 100 }, deps);
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

/** Find the project connected to a repo (for webhook-driven deploys). */
export function findProjectByRepo(
  owner: string,
  repo: string,
  store: DataStore = getRuntime().data,
) {
  return store.projects.findByRepo(owner, repo);
}
