/**
 * Local-dev DeployTarget: build + run each instance as a Docker container on this host,
 * against the local Postgres (Workflow World), reachable at a mapped localhost port.
 *
 * This is the runnable OSS deploy path for `npm run dev` (EDEN_DEPLOY_TARGET=local-docker).
 * It's the honest, minimal version of the managed Nomad/gVisor substrate: same DeployTarget
 * seam, plain `docker run` instead of an orchestrator.
 *
 * Pipeline (contract validated in docs/SPIKE-EVE.md):
 *   build   fetch repo tarball @ commit (GitHub App) → docker multi-stage build (npm ci +
 *           `eve build` run inside linux) → runtime image of the Nitro .output/ + a
 *           build-stage image that keeps node_modules (for the world migration CLI)
 *   deploy  create a per-instance Postgres DB → run `workflow-postgres-setup` from the
 *           build-stage image → docker run -d with WORKFLOW_POSTGRES_URL + secret env on a
 *           mapped 127.0.0.1 port → health-check → return the URL
 *   stop/start  docker stop/start (scale-to-zero)
 *
 * The repo must be deployable off-Vercel: `@workflow/world-postgres` (at the beta line
 * matching its eve version) as a dependency, and agent.ts declaring
 * `experimental.workflow.world` + `build.externalDependencies` for it. See SPIKE-EVE.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import postgres from "postgres";

import { buildEveImage, buildStageTagFor } from "~/deploy/eve-image.server";
import type {
  BuildRequest,
  BuiltArtifact,
  DeployRequest,
  DeployTarget,
  InstanceHealth,
} from "~/seams/types";

const exec = promisify(execFile);

/** Port the eve/Nitro server listens on inside the container. */
const INSTANCE_PORT = Number(process.env.EDEN_INSTANCE_PORT ?? 3000);
/** How the container reaches the host's Postgres (Docker Desktop). */
const DB_HOST_FROM_CONTAINER =
  process.env.EDEN_DB_HOST_FROM_CONTAINER ?? "host.docker.internal";

const containerName = (deploymentId: string) => `eden-inst-${deploymentId}`;
const instanceDbName = (deploymentId: string) =>
  `eden_inst_${deploymentId.replace(/-/g, "").slice(0, 24)}`;

async function docker(args: string[]): Promise<string> {
  const { stdout } = await exec("docker", args, { maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

/** Control-plane Postgres connection info, for provisioning per-instance databases. */
function controlPlaneUrl(): URL {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL not set.");
  return new URL(raw);
}

/** Create the instance's database if absent; return the URL the container should use. */
async function provisionInstanceDb(deploymentId: string): Promise<string> {
  const cp = controlPlaneUrl();
  const dbName = instanceDbName(deploymentId);
  const admin = postgres(cp.toString(), { max: 1 });
  try {
    const existing = await admin`select 1 from pg_database where datname = ${dbName}`;
    if (existing.length === 0) {
      await admin.unsafe(`create database "${dbName}"`);
    }
  } finally {
    await admin.end();
  }
  // URL the *container* uses: same creds, host reachable from inside Docker, instance DB.
  const url = new URL(cp.toString());
  url.hostname = DB_HOST_FROM_CONTAINER;
  url.port = cp.port || "5432";
  url.pathname = `/${dbName}`;
  return url.toString();
}

async function dropInstanceDb(deploymentId: string): Promise<void> {
  const cp = controlPlaneUrl();
  const admin = postgres(cp.toString(), { max: 1 });
  try {
    await admin.unsafe(`drop database if exists "${instanceDbName(deploymentId)}" (force)`);
  } catch {
    // best-effort cleanup
  } finally {
    await admin.end();
  }
}

async function removeIfExists(name: string): Promise<void> {
  try {
    await docker(["rm", "-f", name]);
  } catch {
    // not running / doesn't exist
  }
}

/**
 * Run the Workflow World's schema migrations against the instance DB, using the build-stage
 * image (the migration CLI + SQL files are not traced into the runtime .output — SPIKE-EVE).
 * Skipped when no build-stage image exists (e.g. a plain test image), since such an image
 * cannot be an eve agent needing a World.
 */
async function runWorldMigrations(imageRef: string, dbUrl: string): Promise<void> {
  const buildTag = buildStageTagFor(imageRef);
  try {
    await docker(["image", "inspect", buildTag]);
  } catch {
    return; // no build-stage image — nothing to migrate
  }
  await docker([
    "run",
    "--rm",
    "--add-host",
    "host.docker.internal:host-gateway",
    "-e",
    `WORKFLOW_POSTGRES_URL=${dbUrl}`,
    buildTag,
    "node",
    "node_modules/@workflow/world-postgres/bin/setup.js",
  ]);
}

/** Poll the instance's HTTP endpoint until it responds or the timeout elapses. */
async function waitForHealth(url: string, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.status < 500) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 750));
  }
  return false;
}

export const localDockerTarget: DeployTarget = {
  name: "local-docker",

  async build(req: BuildRequest): Promise<BuiltArtifact> {
    if (!req.installationId) {
      throw new Error(
        `local-docker build for ${req.repo.owner}/${req.repo.repo}@${req.ref.slice(0, 7)} ` +
          "needs a GitHub App installation on the repo to fetch its source.",
      );
    }
    return buildEveImage({
      projectId: req.projectId,
      repo: req.repo,
      ref: req.ref,
      installationId: req.installationId,
    });
  },

  async deploy(req: DeployRequest): Promise<InstanceHealth> {
    if (!req.imageRef) {
      return { status: "failed", detail: "no image to run (build did not produce one)" };
    }
    const name = containerName(req.deploymentId);
    await removeIfExists(name);

    const dbUrl = await provisionInstanceDb(req.deploymentId);
    await runWorldMigrations(req.imageRef, dbUrl);
    // The Postgres World reads WORKFLOW_POSTGRES_URL; DATABASE_URL kept for authored tools.
    const envArgs = Object.entries({
      ...req.env,
      WORKFLOW_POSTGRES_URL: dbUrl,
      DATABASE_URL: dbUrl,
      PORT: String(INSTANCE_PORT),
    }).flatMap(([k, v]) => ["-e", `${k}=${v}`]);

    await docker([
      "run",
      "-d",
      "--name",
      name,
      "--add-host",
      "host.docker.internal:host-gateway",
      "-p",
      `127.0.0.1:0:${INSTANCE_PORT}`,
      ...envArgs,
      req.imageRef,
    ]);

    const hostPort = await docker([
      "inspect",
      "--format",
      `{{(index (index .NetworkSettings.Ports "${INSTANCE_PORT}/tcp") 0).HostPort}}`,
      name,
    ]);
    const url = `http://127.0.0.1:${hostPort}`;

    const healthy = await waitForHealth(url);
    return healthy
      ? { status: "live", url }
      : { status: "failed", url, detail: "container did not become healthy" };
  },

  async stop(deploymentId: string): Promise<void> {
    try {
      await docker(["stop", containerName(deploymentId)]);
    } catch {
      // already stopped / gone
    }
  },

  async start(deploymentId: string): Promise<InstanceHealth> {
    const name = containerName(deploymentId);
    await docker(["start", name]);
    const hostPort = await docker([
      "inspect",
      "--format",
      `{{(index (index .NetworkSettings.Ports "${INSTANCE_PORT}/tcp") 0).HostPort}}`,
      name,
    ]);
    const url = `http://127.0.0.1:${hostPort}`;
    const healthy = await waitForHealth(url);
    return { status: healthy ? "live" : "failed", url };
  },

  async health(deploymentId: string): Promise<InstanceHealth> {
    const name = containerName(deploymentId);
    try {
      const state = await docker([
        "inspect",
        "--format",
        "{{.State.Running}}",
        name,
      ]);
      return { status: state === "true" ? "live" : "stopped" };
    } catch {
      return { status: "stopped", detail: "no container" };
    }
  },
};

/** Full teardown for a deployment (container + its database). Used by the controller/tests. */
export async function destroyInstance(deploymentId: string): Promise<void> {
  await removeIfExists(containerName(deploymentId));
  await dropInstanceDb(deploymentId);
}
