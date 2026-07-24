/**
 * Wake-on-demand for a single environment (Front of House §5): resolve the environment's live
 * deployment, starting a stopped (scaled-to-zero) instance when that's what it takes. Used by
 * the delegation relay (a stopped peer is woken, not denied) and the FOH stream route (opening
 * a session with a stopped agent wakes it).
 *
 * Copies the assistant's wake discipline (app/assistant/instance.server.ts): a `live` row with
 * a url is used as-is — a deploy cutover transiently has two live rows, and any of them serves —
 * otherwise a `stopped` row is started and, only on a `live` health WITH a url, flipped live
 * with the FRESH url. The stale stored url is never reused: docker reallocates the host port on
 * every wake. Returns null when nothing is live and nothing can be woken (never deployed,
 * failed-only rows, or the wake itself failed). The wake budget lives in the deploy target
 * (WAKE_HEALTH_TIMEOUT_MS, deploy.localdocker.server.ts).
 */
import type { DataStore, DeploymentWithRelease } from "~/data/ports";
import { getRuntime } from "~/seams/index.server";
import type { DeployTarget, InstanceHealth } from "~/seams/types";

export async function ensureLiveDeploymentForEnvironment(
  environmentId: string,
  deps: { store?: DataStore; deployTarget?: DeployTarget } = {},
): Promise<DeploymentWithRelease | null> {
  const store = deps.store ?? getRuntime().data;
  const deployTarget = deps.deployTarget ?? getRuntime().deployTarget;

  const rows = await store.deployments.listByEnvironment(environmentId);
  const live = rows.find((d) => d.status === "live" && d.url);
  if (live) return live;

  const stopped = rows.find((d) => d.status === "stopped");
  if (!stopped) return null;

  const health = await deployTarget.start(stopped.id).catch(
    (error): InstanceHealth => ({
      status: "failed",
      detail: error instanceof Error ? error.message : String(error),
    }),
  );
  if (health.status !== "live" || !health.url) return null;

  await store.deployments.update(stopped.id, {
    status: "live",
    url: health.url,
  });
  return { ...stopped, status: "live", url: health.url };
}
