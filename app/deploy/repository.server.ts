/**
 * Repository lifecycle (M5.8). Deleting a repository is a FULL Eden-side teardown (owner
 * decision): every member environment's instances are destroyed (containers + per-instance
 * databases via DeployTarget.destroy, stop fallback), then the project row is deleted and
 * the FK cascade takes agents, environments, releases, deployments, drafts, secrets, and
 * run history with it. The GitHub repository itself is NEVER touched.
 */
import type { DataStore } from "~/data/ports";
import { getRuntime } from "~/seams/index.server";
import type { DeployTarget } from "~/seams/types";

export interface RepositoryDeps {
  store: DataStore;
  deployTarget: DeployTarget;
}

function repoDeps(): RepositoryDeps {
  const r = getRuntime();
  return { store: r.data, deployTarget: r.deployTarget };
}

export async function deleteRepository(
  input: { projectId: string; createdBy?: string | null },
  deps: RepositoryDeps = repoDeps(),
): Promise<void> {
  const { store, deployTarget } = deps;
  const project = await store.projects.findById(input.projectId);
  if (!project) throw new Error("Repository not found.");

  // Infra first — after the row delete nothing could find the containers/databases again.
  // Best-effort per instance: a half-torn-down deployment must not leave the repository
  // undeletable.
  const envs = await store.environments.listByProject(project.id);
  for (const env of envs) {
    const deployments = await store.deployments.listByEnvironment(env.id);
    for (const dep of deployments) {
      try {
        if (deployTarget.destroy) await deployTarget.destroy(dep.id);
        else await deployTarget.stop(dep.id);
      } catch {
        // container already gone / target unreachable — the row delete is authoritative
      }
    }
  }

  // Audit before the delete (the audit table is org-scoped and survives the cascade).
  await store.audit.record({
    orgId: project.orgId,
    actorUserId: input.createdBy ?? null,
    action: "repository.delete",
    target: project.name,
    meta: { projectId: project.id, environments: envs.length },
  });
  await store.projects.deleteById(project.id);
}
