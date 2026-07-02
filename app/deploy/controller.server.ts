/**
 * Deploy controller + release registry (Deploy pillar, M2 — PRD §7.4/§7.7, ARCH §3.1/§3.9).
 *
 * Orchestrates the pipeline over the `DeployTarget` seam: cut an immutable Release (merge
 * commit + content-addressed image), deploy it to an environment as a weighted deployment,
 * fast-rollback by re-pointing to a prior Release, and set the session-sticky traffic split
 * across concurrently-live Releases.
 *
 * The DeployTarget's build/deploy need the eve+docker toolchain; where it's unavailable the
 * controller still records the Release and deployment rows and marks the deployment `failed`
 * with the tooling error, so the control plane and UI work end-to-end without real infra.
 */
import { and, eq, sql } from "drizzle-orm";

import { db } from "~/db/client.server";
import { deployments, environments, projects, releases } from "~/db/schema";
import { recordAudit } from "~/managed/audit.server";
import { getRuntime } from "~/seams/index.server";

export type Release = typeof releases.$inferSelect;
export type Deployment = typeof deployments.$inferSelect;

/** Next `vN` label for a project (1-based on existing release count). */
async function nextVersionLabel(projectId: string): Promise<string> {
  const [{ c }] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(releases)
    .where(eq(releases.projectId, projectId));
  return `v${(c ?? 0) + 1}`;
}

/**
 * Record an immutable Release for a project at a git commit. Image is built lazily at deploy
 * time (imageRef stays null until then). Immutability is inherited from git + image digests.
 * Concurrent creates (e.g. two webhook deliveries) race on the label; the unique
 * (project, version) constraint catches it and we retry with a fresh count.
 */
export async function createRelease(input: {
  projectId: string;
  gitSha: string;
  changelog?: string | null;
  createdBy?: string | null;
}): Promise<Release> {
  for (let attempt = 0; ; attempt++) {
    const version = await nextVersionLabel(input.projectId);
    try {
      const [row] = await db
        .insert(releases)
        .values({
          projectId: input.projectId,
          version,
          gitSha: input.gitSha,
          changelog: input.changelog ?? null,
          createdBy: input.createdBy ?? null,
        })
        .returning();
      return row;
    } catch (err) {
      const isUniqueViolation =
        err instanceof Error && /releases_project_version_uq/.test(err.message);
      if (!isUniqueViolation || attempt >= 3) throw err;
    }
  }
}

/** Deployments for an environment, newest first, joined to their release version. */
export async function listDeployments(environmentId: string) {
  return db
    .select({
      id: deployments.id,
      status: deployments.status,
      trafficWeight: deployments.trafficWeight,
      url: deployments.url,
      errorDetail: deployments.errorDetail,
      createdAt: deployments.createdAt,
      releaseId: deployments.releaseId,
      version: releases.version,
      gitSha: releases.gitSha,
    })
    .from(deployments)
    .innerJoin(releases, eq(deployments.releaseId, releases.id))
    .where(eq(deployments.environmentId, environmentId))
    .orderBy(sql`${deployments.createdAt} desc`);
}

/**
 * Deploy a Release to an environment: build the image if needed, run it via the DeployTarget,
 * and record a deployment row with the resulting health/status. Injects the environment's
 * resolved secrets as container env at start (SecretsProvider seam).
 */
export async function deployRelease(input: {
  environmentId: string;
  releaseId: string;
  trafficWeight?: number;
  createdBy?: string | null;
}): Promise<Deployment> {
  const [release] = await db
    .select()
    .from(releases)
    .where(eq(releases.id, input.releaseId))
    .limit(1);
  if (!release) throw new Error("Release not found.");
  const [env] = await db
    .select()
    .from(environments)
    .where(eq(environments.id, input.environmentId))
    .limit(1);
  if (!env) throw new Error("Environment not found.");
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, release.projectId))
    .limit(1);

  const [dep] = await db
    .insert(deployments)
    .values({
      environmentId: input.environmentId,
      releaseId: input.releaseId,
      status: "building",
      trafficWeight: input.trafficWeight ?? 100,
      createdBy: input.createdBy ?? null,
    })
    .returning();

  const runtime = getRuntime();
  try {
    let imageRef = release.imageRef;
    if (!imageRef && project?.repoOwner && project.repoName) {
      const built = await runtime.deployTarget.build({
        projectId: release.projectId,
        repo: { owner: project.repoOwner, repo: project.repoName },
        ref: release.gitSha,
        installationId: project.repoInstallationId,
      });
      imageRef = built.imageRef;
      await db
        .update(releases)
        .set({ imageRef: built.imageRef })
        .where(eq(releases.id, release.id));
    }

    const env2 = await runtime.secrets.resolve(release.projectId, input.environmentId);
    const health = await runtime.deployTarget.deploy({
      deploymentId: dep.id,
      imageRef: imageRef ?? "",
      env: env2,
    });
    const [updated] = await db
      .update(deployments)
      .set({
        status: health.status,
        url: health.url ?? null,
        errorDetail: health.status === "failed" ? (health.detail ?? null) : null,
        updatedAt: new Date(),
      })
      .where(eq(deployments.id, dep.id))
      .returning();
    if (project) {
      await recordAudit({
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
    const [failed] = await db
      .update(deployments)
      .set({ status: "failed", errorDetail: detail, updatedAt: new Date() })
      .where(eq(deployments.id, dep.id))
      .returning();
    return failed;
  }
}

/**
 * Fast rollback (D9): deploy a prior Release again at full weight and drain the others in the
 * environment. The prior image is reused (no rebuild) when it's already been built.
 */
export async function rollbackTo(input: {
  environmentId: string;
  releaseId: string;
  createdBy?: string | null;
}): Promise<Deployment> {
  await db
    .update(deployments)
    .set({ status: "draining", trafficWeight: 0, updatedAt: new Date() })
    .where(
      and(
        eq(deployments.environmentId, input.environmentId),
        eq(deployments.status, "live"),
      ),
    );
  return deployRelease({ ...input, trafficWeight: 100 });
}

/**
 * Set the weighted, session-sticky traffic split across an environment's deployments (D9/D10).
 * Weights are relative integers the ingress splitter normalizes; the human decides them.
 */
export async function setTrafficSplit(
  environmentId: string,
  weights: { deploymentId: string; weight: number }[],
): Promise<void> {
  // One transaction: a crash mid-way must not leave the environment on a partial split.
  await db.transaction(async (tx) => {
    for (const w of weights) {
      await tx
        .update(deployments)
        .set({ trafficWeight: Math.max(0, Math.round(w.weight)), updatedAt: new Date() })
        .where(
          and(
            eq(deployments.id, w.deploymentId),
            eq(deployments.environmentId, environmentId),
          ),
        );
    }
  });
}

/** Find the project connected to a repo (for webhook-driven deploys). */
export async function findProjectByRepo(owner: string, repo: string) {
  const [row] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.repoOwner, owner), eq(projects.repoName, repo)))
    .limit(1);
  return row;
}
