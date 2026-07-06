/**
 * The built-in assistant's instance lifecycle (docs/ASSISTANT.md §4/§5). The assistant deploys
 * on the SAME substrate as any eve agent — an internal environment, a synthesized release per
 * template content-hash, and a Docker deployment via the DeployTarget — but it builds from the
 * bundled local `assistant-template/` (not a GitHub tarball) and is injected with NO user
 * secrets. Long work (build + deploy) runs through the jobs queue (`assistant_deploy`); the UI
 * shows a provisioning state until the instance is live.
 */
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import type { Agent, DataStore, Environment } from "~/data/ports";
import { buildAssistantImage } from "~/deploy/eve-image.server";
import { enqueue } from "~/jobs/queue.server";
import {
  getWorkspaceAssistantModel,
  getWorkspaceModelKey,
} from "~/org/workspace.server";
import { getRuntime } from "~/seams/index.server";
import { mintAssistantToken } from "./token.server";

/** Internal environment + roster name for the assistant. */
const ASSISTANT_ENV = "assistant";
const ASSISTANT_NAME = "assistant";
const ASSISTANT_ROOT = ".eden/assistant";
/** Eden's built-in fallback when neither a project override nor a workspace default is set.
 * Platform-wide default: a cheap, capable model so a silent default never runs up a real bill. */
export const DEFAULT_MODEL = "z-ai/glm-5.2";

/** Where the bundled template lives (mirrors the CatalogSource fixture reading <cwd>/catalog). */
export function assistantTemplateDir(): string {
  return process.env.EDEN_ASSISTANT_TEMPLATE_DIR ?? path.join(process.cwd(), "assistant-template");
}

/** The fixed, Eden-owned layer — rendered read-only on the config page so it's inspectable. */
export interface AssistantFixedLayer {
  instructions: string;
  tools: string[];
}

let cachedFixedLayer: AssistantFixedLayer | null = null;

export async function assistantFixedLayer(): Promise<AssistantFixedLayer> {
  if (cachedFixedLayer) return cachedFixedLayer;
  const dir = assistantTemplateDir();
  const instructions = await readFile(path.join(dir, "agent", "instructions.md"), "utf8").catch(
    () => "",
  );
  const tools = await readdir(path.join(dir, "agent", "tools"))
    .then((names) =>
      names
        .filter((n) => n.endsWith(".ts"))
        .map((n) => n.replace(/\.ts$/, ""))
        .sort(),
    )
    .catch(() => []);
  cachedFixedLayer = { instructions, tools };
  return cachedFixedLayer;
}

let cachedHash: string | null = null;

/** Content hash of the bundled template — the assistant's release identity + image tag. */
export async function assistantTemplateHash(): Promise<string> {
  if (cachedHash) return cachedHash;
  const dir = assistantTemplateDir();
  const files: string[] = [];
  async function walk(rel: string) {
    const entries = await readdir(path.join(dir, rel), { withFileTypes: true });
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      // Skip build artifacts / installed deps that aren't part of the source identity.
      if (["node_modules", ".eve", ".output", ".git", ".workflow-data"].includes(e.name)) continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(child);
      else files.push(child);
    }
  }
  await walk("");
  const hash = createHash("sha256");
  for (const rel of files.sort()) {
    hash.update(rel);
    hash.update("\0");
    hash.update(await readFile(path.join(dir, rel)));
    hash.update("\0");
  }
  cachedHash = hash.digest("hex").slice(0, 16);
  return cachedHash;
}

function assistantImageRef(hash: string): string {
  return `eden-assistant:${hash}`;
}

/** gitSha marker for a template-hash release (not a real repo commit — see docs §3). */
function templateGitSha(hash: string): string {
  return `tmpl-${hash}`;
}

// ── Agent + environment ───────────────────────────────────────────────────────

export interface AssistantAgent {
  agent: Agent;
  environment: Environment;
}

/**
 * Ensure the project's built-in assistant agent row (kind 'assistant') and its internal
 * environment exist. Collision-safe: if a legacy roster member already owns the name "assistant"
 * (pre-reservation repos), the internal row falls back to "assistant-internal".
 */
export async function ensureAssistantAgent(
  projectId: string,
  store: DataStore = getRuntime().data,
): Promise<AssistantAgent> {
  let agent = await store.agents.findAssistant(projectId);
  if (!agent) {
    const roster = await store.agents.listByProject(projectId);
    const name = roster.some((a) => a.name === ASSISTANT_NAME)
      ? "assistant-internal"
      : ASSISTANT_NAME;
    agent = await store.agents.createAssistant({ projectId, name, root: ASSISTANT_ROOT });
  }
  await store.environments.ensureDefault(projectId, agent.id); // guarantees ≥1 env
  const envs = await store.environments.listByAgent(agent.id);
  const environment =
    envs.find((e) => e.name === ASSISTANT_ENV) ??
    (await renameFirstEnv(envs[0], store));
  return { agent, environment };
}

/** The assistant environment is named "assistant"; rename the seeded "default" to it. */
async function renameFirstEnv(env: Environment, store: DataStore): Promise<Environment> {
  if (env.name === ASSISTANT_ENV) return env;
  await store.environments.rename(env.id, ASSISTANT_ENV).catch(() => {});
  const refreshed = await store.environments.findById(env.id);
  return refreshed ?? env;
}

// ── Deploy env assembly (no user secrets, ever) ────────────────────────────────

function edenApiUrl(): string {
  if (process.env.EDEN_ASSISTANT_API_URL) return process.env.EDEN_ASSISTANT_API_URL;
  const port = process.env.PORT ?? (process.env.NODE_ENV === "production" ? "3000" : "5173");
  return `http://host.docker.internal:${port}`;
}

async function assistantEnv(input: {
  orgId: string;
  deploymentId: string;
}): Promise<Record<string, string>> {
  const openRouterKey =
    (await getWorkspaceModelKey(input.orgId).catch(() => null)) ??
    process.env.OPENROUTER_API_KEY ??
    null;
  if (!openRouterKey) {
    throw new Error(
      "No OpenRouter key configured for the assistant. Add one in Org settings → Model provider " +
        "(or set OPENROUTER_API_KEY in the server env).",
    );
  }
  const model =
    (await getWorkspaceAssistantModel(input.orgId).catch(() => null)) ?? DEFAULT_MODEL;
  // Built fresh (no user secrets to shadow), but the Eden-owned keys are the only ones set.
  return {
    OPENROUTER_API_KEY: openRouterKey,
    EDEN_ASSISTANT_MODEL: model,
    EDEN_API_URL: edenApiUrl(),
    EDEN_ASSISTANT_TOKEN: mintAssistantToken(input.deploymentId),
  };
}

// ── Provisioning (the assistant_deploy job body) ───────────────────────────────

export interface AssistantDeployPayload {
  projectId: string;
  [key: string]: unknown;
}

/**
 * The `assistant_deploy` job body: ensure agent/env/release/image, then deploy the instance.
 * Idempotent — takes over any pending deployment for the env and reuses a built image.
 */
export async function runAssistantDeploy(
  payload: AssistantDeployPayload,
  store: DataStore = getRuntime().data,
): Promise<{ status: string; url: string | null; deploymentId: string }> {
  const runtime = getRuntime();
  const project = await store.projects.findById(payload.projectId);
  if (!project) throw new Error("Project not found for assistant deploy.");
  const { agent, environment } = await ensureAssistantAgent(project.id, store);

  const hash = await assistantTemplateHash();
  const gitSha = templateGitSha(hash);
  const imageRef = assistantImageRef(hash);

  // Reuse the release for this template hash, or synthesize one.
  let release =
    (await store.releases.findByCommit(agent.id, gitSha)) ??
    (await store.releases.insert({
      projectId: project.id,
      agentId: agent.id,
      version: `t${(await store.releases.countByAgent(agent.id)) + 1}`,
      gitSha,
      changelog: `Assistant template ${hash}`,
    }));

  // Build the shared image if this release hasn't recorded one yet (docker layer cache makes a
  // repeat build across projects cheap).
  if (!release.imageRef) {
    const built = await buildAssistantImage({ imageRef, templateDir: assistantTemplateDir() });
    await store.releases.setImageRef(release.id, built.imageRef);
    release = { ...release, imageRef: built.imageRef };
  }

  // Take over a pending/building row, else create one (visible immediately).
  const existing = await store.deployments.listByEnvironment(environment.id);
  const takeover = existing.find((d) => d.status === "pending" || d.status === "building");
  const dep = takeover
    ? await store.deployments.update(takeover.id, { status: "building" })
    : await store.deployments.insert({
        environmentId: environment.id,
        releaseId: release.id,
        status: "building",
        trafficWeight: 100,
      });

  try {
    const env = await assistantEnv({ orgId: project.orgId, deploymentId: dep.id });
    const health = await runtime.deployTarget.deploy({
      deploymentId: dep.id,
      imageRef: release.imageRef ?? imageRef,
      env,
      worldKey: environment.id,
    });
    if (health.status !== "live") {
      await store.deployments.update(dep.id, {
        status: "failed",
        errorDetail: health.detail ?? "assistant instance did not become healthy",
      });
      return { status: "failed", url: null, deploymentId: dep.id };
    }
    // Demote any other live rows in the env (single live assistant), then mark live.
    for (const other of existing) {
      if (other.id !== dep.id && other.status === "live") {
        await runtime.deployTarget.stop(other.id).catch(() => {});
        await store.deployments.update(other.id, { status: "stopped", trafficWeight: 0 });
      }
    }
    await store.deployments.update(dep.id, { status: "live", url: health.url ?? null });
    return { status: "live", url: health.url ?? null, deploymentId: dep.id };
  } catch (error) {
    await store.deployments.update(dep.id, {
      status: "failed",
      errorDetail: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

// ── The entry the UI / stream route calls ──────────────────────────────────────

export interface AssistantInstance {
  status: "live" | "provisioning" | "failed";
  url: string | null;
  deploymentId: string | null;
  environmentId: string;
  releaseId: string | null;
  version: string | null;
  agentId: string;
  error?: string | null;
}

/**
 * Ensure a live assistant instance for a turn. Fast paths: a live deployment on the current
 * template image is returned immediately; a stopped one is woken with `start()`. Otherwise an
 * `assistant_deploy` job is queued and a `provisioning` status is returned so the UI can show
 * "setting up your assistant…" and poll.
 */
export async function ensureAssistantInstance(
  projectId: string,
  store: DataStore = getRuntime().data,
): Promise<AssistantInstance> {
  const runtime = getRuntime();
  const { agent, environment } = await ensureAssistantAgent(projectId, store);
  const hash = await assistantTemplateHash();
  const currentSha = templateGitSha(hash);

  const deployments = await store.deployments.listByEnvironment(environment.id);
  const base = {
    environmentId: environment.id,
    agentId: agent.id,
  };

  // A live deployment on the CURRENT template → use it (wake first if the container is stopped).
  const live = deployments.find((d) => d.status === "live" && d.gitSha === currentSha);
  if (live) {
    let url = live.url;
    if (!url) {
      const woke = await runtime.deployTarget.start(live.id).catch(() => null);
      url = woke?.url ?? null;
      if (woke?.url) await store.deployments.update(live.id, { url: woke.url, status: "live" });
    }
    if (url) {
      return {
        ...base,
        status: "live",
        url,
        deploymentId: live.id,
        releaseId: live.releaseId,
        version: live.version,
      };
    }
  }

  // A stopped deployment on the current template → wake it.
  const stopped = deployments.find((d) => d.status === "stopped" && d.gitSha === currentSha);
  if (stopped) {
    const health = await runtime.deployTarget.start(stopped.id).catch((error) => ({
      status: "failed" as const,
      url: undefined,
      detail: error instanceof Error ? error.message : String(error),
    }));
    if (health.status === "live" && health.url) {
      await store.deployments.update(stopped.id, { status: "live", url: health.url });
      return {
        ...base,
        status: "live",
        url: health.url,
        deploymentId: stopped.id,
        releaseId: stopped.releaseId,
        version: stopped.version,
      };
    }
  }

  // Already provisioning?
  const pending = deployments.find((d) => d.status === "pending" || d.status === "building");
  if (pending) {
    return {
      ...base,
      status: "provisioning",
      url: null,
      deploymentId: pending.id,
      releaseId: pending.releaseId,
      version: pending.version,
    };
  }

  // Nothing usable (never deployed, image changed after an Eden upgrade, or previous failure):
  // queue a build+deploy.
  await enqueue("assistant_deploy", { projectId } satisfies AssistantDeployPayload, undefined, store);
  return {
    ...base,
    status: "provisioning",
    url: null,
    deploymentId: null,
    releaseId: null,
    version: null,
  };
}

/** A read-only snapshot for the loader — NO side effects (no enqueue, no wake, no build). */
export interface AssistantSnapshot {
  status: "live" | "provisioning" | "failed" | "idle";
  agentId: string | null;
  environmentId: string | null;
  /** Human stage label while provisioning (e.g. "Building the assistant image…"); null otherwise. */
  provisionStage: string | null;
  /** ISO timestamp the current provisioning deployment started, for an elapsed timer; null otherwise. */
  provisionStartedAt: string | null;
  /** Present only when live. */
  target: {
    deploymentId: string;
    environmentId: string;
    releaseId: string;
    url: string;
    version: string;
    environmentName: string;
  } | null;
}

/**
 * Report the assistant instance's current status without provisioning or waking it (loader-safe).
 * `idle` means nothing usable is running (never deployed, or stopped) — the UI offers to set it
 * up, and a turn provisions/wakes it on demand via `ensureAssistantInstance`.
 */
export async function peekAssistantInstance(
  projectId: string,
  store: DataStore = getRuntime().data,
): Promise<AssistantSnapshot> {
  const idle = { provisionStage: null, provisionStartedAt: null } as const;
  const agent = await store.agents.findAssistant(projectId);
  if (!agent) return { status: "idle", agentId: null, environmentId: null, target: null, ...idle };
  const envs = await store.environments.listByAgent(agent.id);
  const env = envs.find((e) => e.name === ASSISTANT_ENV) ?? envs[0];
  if (!env) return { status: "idle", agentId: agent.id, environmentId: null, target: null, ...idle };
  const base = { agentId: agent.id, environmentId: env.id, ...idle };

  const currentSha = templateGitSha(await assistantTemplateHash());
  const deployments = await store.deployments.listByEnvironment(env.id);
  const live = deployments.find((d) => d.status === "live" && d.url && d.gitSha === currentSha);
  if (live && live.url) {
    return {
      ...base,
      status: "live",
      target: {
        deploymentId: live.id,
        environmentId: env.id,
        releaseId: live.releaseId,
        url: live.url,
        version: live.version,
        environmentName: ASSISTANT_ENV,
      },
    };
  }
  const active = deployments.find((d) => d.status === "pending" || d.status === "building");
  if (active) {
    return {
      ...base,
      status: "provisioning",
      target: null,
      provisionStage:
        active.status === "building"
          ? "Building the assistant image…"
          : "Preparing the build…",
      provisionStartedAt: active.createdAt.toISOString(),
    };
  }
  if (deployments.length > 0 && deployments.every((d) => d.status === "failed")) {
    return { ...base, status: "failed", target: null };
  }
  return { ...base, status: "idle", target: null };
}

/**
 * Restart the assistant instance so it re-fetches its config bundle and rebuilds (used by the
 * refresh-on-merge hook when `.eden/assistant/**` changes). Best-effort stop → start on the
 * current live/stopped deployment; a missing instance is a no-op (it provisions on next use).
 */
export async function restartAssistantInstance(
  projectId: string,
  store: DataStore = getRuntime().data,
): Promise<boolean> {
  const runtime = getRuntime();
  const agent = await store.agents.findAssistant(projectId);
  if (!agent) return false;
  const envs = await store.environments.listByAgent(agent.id);
  const env = envs.find((e) => e.name === ASSISTANT_ENV) ?? envs[0];
  if (!env) return false;
  const deployments = await store.deployments.listByEnvironment(env.id);
  const target = deployments.find((d) => d.status === "live" || d.status === "stopped");
  if (!target) return false;
  await runtime.deployTarget.stop(target.id).catch(() => {});
  const health = await runtime.deployTarget.start(target.id).catch(() => null);
  if (health?.status === "live") {
    await store.deployments.update(target.id, { status: "live", url: health.url ?? null });
    return true;
  }
  await store.deployments.update(target.id, { status: "stopped", trafficWeight: 0 }).catch(() => {});
  return false;
}
