/**
 * Environment lifecycle (M5.7 — user-defined environments). Environments are per-agent rows
 * the user creates, renames, and deletes; the only invariant Eden enforces is that a member
 * always has at least one (the FIRST by creation is its primary — ship target, hero card).
 *
 * Delete is the loaded one: the row cascade removes the env's deployments (and their
 * schedules) plus env-scoped secrets, but rows can't stop docker containers or drop the
 * environment's Workflow world DB — so delete tears infra down FIRST via the DeployTarget
 * (`destroy` when the target has it, `stop` otherwise) per deployment, then `destroyWorld`
 * once for the environment, all best-effort.
 */
import type { DataStore } from "~/data/ports";
import { getRuntime } from "~/seams/index.server";
import type { DeployTarget } from "~/seams/types";

export interface EnvironmentDeps {
  store: DataStore;
  deployTarget: DeployTarget;
}

function envDeps(): EnvironmentDeps {
  const r = getRuntime();
  return { store: r.data, deployTarget: r.deployTarget };
}

/** True for the Postgres unique-violation the (agent, name) index raises. */
function isDuplicateName(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "23505"
  );
}

function validName(raw: string): string {
  const name = raw.trim();
  if (!name) throw new Error("Environment name is required.");
  if (name.length > 64) throw new Error("Environment name is too long (max 64 characters).");
  return name;
}

export async function createEnvironment(
  input: {
    projectId: string;
    agentId: string;
    name: string;
    orgId: string;
    createdBy?: string | null;
  },
  deps: EnvironmentDeps = envDeps(),
) {
  const name = validName(input.name);
  try {
    const env = await deps.store.environments.create({
      projectId: input.projectId,
      agentId: input.agentId,
      name,
    });
    await deps.store.audit.record({
      orgId: input.orgId,
      actorUserId: input.createdBy ?? null,
      action: "environment.create",
      target: name,
      meta: { environmentId: env.id, agentId: input.agentId },
    });
    return env;
  } catch (err) {
    if (isDuplicateName(err)) {
      throw new Error(`An environment named "${name}" already exists for this member.`);
    }
    throw err;
  }
}

export async function renameEnvironment(
  input: {
    environmentId: string;
    name: string;
    orgId: string;
    createdBy?: string | null;
  },
  deps: EnvironmentDeps = envDeps(),
): Promise<void> {
  const name = validName(input.name);
  const env = await deps.store.environments.findById(input.environmentId);
  if (!env) throw new Error("Environment not found.");
  if (env.name === name) return;
  try {
    await deps.store.environments.rename(env.id, name);
  } catch (err) {
    if (isDuplicateName(err)) {
      throw new Error(`An environment named "${name}" already exists for this member.`);
    }
    throw err;
  }
  await deps.store.audit.record({
    orgId: input.orgId,
    actorUserId: input.createdBy ?? null,
    action: "environment.rename",
    target: name,
    meta: { environmentId: env.id, from: env.name },
  });
}

/**
 * Delete an environment: tear down every deployment's infra (container + instance state),
 * then remove the row — the cascade takes deployment history and env-scoped secrets with
 * it (agent-wide secrets are untouched). Refuses only when it's the member's last one.
 */
export async function deleteEnvironment(
  input: { environmentId: string; orgId: string; createdBy?: string | null },
  deps: EnvironmentDeps = envDeps(),
): Promise<void> {
  const { store, deployTarget } = deps;
  const env = await store.environments.findById(input.environmentId);
  if (!env) throw new Error("Environment not found.");

  // Infra first: after the row delete the deployment ids are gone and nothing could find
  // the containers/databases again. Best-effort — a half-torn-down instance must not
  // leave the environment undeletable.
  const deployments = await store.deployments.listByEnvironment(env.id);
  for (const dep of deployments) {
    try {
      if (deployTarget.destroy) await deployTarget.destroy(dep.id);
      else await deployTarget.stop(dep.id);
    } catch {
      // container already gone / target unreachable — the row delete is authoritative
    }
  }
  // Now that no deployment survives, drop the environment's shared Workflow world (its
  // sessions + sandboxes). Per-deployment destroy no longer does this — the world is shared.
  try {
    await deployTarget.destroyWorld?.(env.id);
  } catch {
    // best-effort — a leftover world DB never blocks the environment delete
  }

  const deleted = await store.environments.deleteById(env.id);
  if (!deleted) {
    throw new Error(
      "This is the member's only environment — an agent needs at least one. Create another before deleting this one.",
    );
  }
  await store.audit.record({
    orgId: input.orgId,
    actorUserId: input.createdBy ?? null,
    action: "environment.delete",
    target: env.name,
    meta: { environmentId: env.id, deployments: deployments.length },
  });
}
