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
import { overlayLock, requiredScopesByProvider } from "~/marketplace/lock";
import { enqueue } from "~/jobs/queue.server";
import { getRuntime } from "~/seams/index.server";
import type { DeployTarget, SecretScope, SecretsProvider } from "~/seams/types";
import { teammateRoster } from "~/team/roster.server";
import { mintDelegationToken } from "~/team/token.server";
import { getDiscordAppConfig } from "~/discord/config.server";
import { DEPLOYMENT_CONTAINER_CLEANUP_GRACE_MS } from "./cleanup.server";
import { isVersionLabelCollision, versionLabel } from "./versioning";

export type { Release, Deployment } from "~/data/ports";

/** Everything deployRelease/rollbackTo touch: persistence + the two infra seams. */
export interface DeployDeps {
  store: DataStore;
  deployTarget: DeployTarget;
  secrets: SecretsProvider;
  /** Org-level OpenRouter key lookup used by the authoring assistant and deployed agents. */
  workspaceModelKey?: (orgId: string) => Promise<string | null>;
  /** Names of secrets marked "available in the agent's sandbox shell" for a deploy scope. */
  sandboxExposedNames?: (scope: SecretScope) => Promise<string[]>;
  /**
   * Env for the agent's active auth-brokered connection grant (issue #30): the operator Google
   * client creds + the sealed refresh token, so the shipped eve connection self-refreshes tokens.
   * `{}` when there's no grant; THROWS (failing the deploy) when the grant is dead or (when
   * `requiredScopes` is supplied) under-scoped for the installed connectors (issue #69).
   */
  connectionGrantEnv?: (
    scope: SecretScope,
    requiredScopes?: string | null,
  ) => Promise<Record<string, string>>;
  /**
   * Committed `eden-lock.json` content at a release's commit, for deploy-time scope-coverage
   * validation (issue #69). null when absent/unfetchable — coverage is then skipped.
   */
  agentLock?: (input: {
    installationId: string;
    owner: string;
    repo: string;
    ref: string;
  }) => Promise<string | null>;
}

function deployDeps(): DeployDeps {
  const r = getRuntime();
  return {
    store: r.data,
    deployTarget: r.deployTarget,
    secrets: r.secrets,
    workspaceModelKey: (orgId) =>
      import("~/org/workspace.server").then((m) => m.getWorkspaceModelKey(orgId)),
    sandboxExposedNames: (scope) =>
      import("~/seams/oss/secret-store").then((m) => m.listSandboxExposedNames(scope)),
    connectionGrantEnv: (scope, requiredScopes) =>
      import("~/connections/deploy.server").then((m) =>
        m.connectionGrantEnv(scope, fetch, undefined, requiredScopes),
      ),
    agentLock: ({ installationId, owner, repo, ref }) =>
      import("~/github/repo.server")
        .then((m) => m.fetchAgentSource(installationId, { owner, repo, ref }))
        .then((s) => s.files["eden-lock.json"] ?? null)
        .catch(() => null),
  };
}

function hasModelCredential(env: Record<string, string>): boolean {
  return Boolean(
    env.OPENROUTER_API_KEY || env.AI_GATEWAY_API_KEY || env.VERCEL_OIDC_TOKEN,
  );
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

async function scheduleDeploymentContainerCleanup(
  store: DataStore,
  deploymentIds: string[],
): Promise<void> {
  if (deploymentIds.length === 0) return;
  const runAt = new Date(Date.now() + Math.max(0, DEPLOYMENT_CONTAINER_CLEANUP_GRACE_MS));
  try {
    await Promise.all(
      deploymentIds.map((deploymentId) =>
        enqueue(
          "cleanup_deployment_container",
          { deploymentId },
          { runAt, maxAttempts: 3 },
          store,
        ),
      ),
    );
  } catch (error) {
    console.warn("[deploy] failed to schedule deployment container cleanup", error);
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
  // Repo-commit releases are per member; the built-in assistant is versioned by template hash,
  // not by repo commits, so it is excluded here.
  const roster = (await store.agents.listByProject(input.projectId)).filter(
    (a) => a.kind === "member",
  );
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
  // The project/agent/roster lookups and the building-row upsert don't depend on each other.
  const [project, agent, allAgents, dep] = await Promise.all([
    store.projects.findById(release.projectId),
    store.agents.findById(release.agentId),
    store.agents.listByProject(release.projectId),
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

  // A team member (an `agents/<name>/agent` root — never the single-agent repo's "agent") gets
  // Eden's delegation wiring: the ask-teammate tool baked into its image (D2) and the relay
  // coordinates + roster injected as env (D3). A team of one is a member too — the tool ships
  // and the env is set; EDEN_TEAMMATES is simply an empty roster.
  // Roster for teammate wiring is real members only (never the built-in assistant).
  const roster = allAgents.filter((a) => a.kind === "member");
  const isTeamMember = !!agent && agent.kind === "member" && agent.root !== "agent";

  try {
    const scope: SecretScope = {
      projectId: release.projectId,
      agentId: release.agentId,
      environmentId: input.environmentId,
    };
    const envVars = await secrets.resolve(scope);
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
    if (project && deps.workspaceModelKey && !hasModelCredential(envVars)) {
      throw new Error(
        "No model provider key configured for this deployment. Add an OpenRouter key in Org settings -> Model provider, or set an agent/environment secret named OPENROUTER_API_KEY, then redeploy.",
      );
    }

    // EDEN_SANDBOX_ENV (sandbox exposure convention): the comma-joined NAMES of the secrets
    // the human marked "available in the agent's sandbox shell"; the scaffolded sandbox.ts
    // forwards exactly those vars into the sandbox env (~/eve/templates). Eden-owned and set
    // AFTER the secret resolve, so a user secret named EDEN_SANDBOX_ENV can never smuggle its
    // own allowlist. Names only — never values — and only names that actually resolved to an
    // injected env var (exposing a secret that doesn't exist in scope forwards nothing).
    delete envVars.EDEN_SANDBOX_ENV;
    const exposed = deps.sandboxExposedNames ? await deps.sandboxExposedNames(scope) : [];
    const allowlist = exposed.filter((name) => name in envVars);
    if (allowlist.length > 0) envVars.EDEN_SANDBOX_ENV = allowlist.join(",");

    // Team delegation (D3): a team member gets the relay coordinates, an HMAC token identifying
    // THIS deployment, and its roster — all Eden-owned, so stripped from user secrets first (the
    // same anti-shadowing rule as EDEN_SANDBOX_ENV) then set. Discovery (EDEN_TEAMMATES) is env;
    // authorization is enforced live at the relay, so a roster here is never permission-filtered.
    for (const key of [
      "EDEN_TEAM_URL",
      "EDEN_TEAM_TOKEN",
      "EDEN_TEAMMATES",
      "EDEN_DELEGATION_TIMEOUT_MS",
    ]) {
      delete envVars[key];
    }
    if (isTeamMember && project && agent) {
      // Default relay port matches Eden's production host (3000) and Vite dev server (5173,
      // vite.config.ts). PORT wins when set.
      envVars.EDEN_TEAM_URL =
        process.env.EDEN_TEAM_RELAY_URL ??
        `http://host.docker.internal:${process.env.PORT ?? (process.env.NODE_ENV === "production" ? "3000" : "5173")}`;
      envVars.EDEN_TEAM_TOKEN = mintDelegationToken(dep.id);
      const teammates = await teammateRoster({
        project: {
          repoOwner: project.repoOwner ?? "",
          repoName: project.repoName ?? "",
          repoInstallationId: project.repoInstallationId ?? "",
        },
        roster,
        selfAgentId: agent.id,
      });
      envVars.EDEN_TEAMMATES = JSON.stringify(teammates);
      // Keep the tool's fetch budget aligned with the relay's when an operator overrides it.
      if (process.env.EDEN_DELEGATION_TIMEOUT_MS) {
        envVars.EDEN_DELEGATION_TIMEOUT_MS = process.env.EDEN_DELEGATION_TIMEOUT_MS;
      }
    }

    // Shared Discord app (issue #32): the bot token can act in every connected server across
    // all tenants, so it NEVER reaches an instance — instances get only the public credentials
    // (application id + public key, used for inbound Ed25519 verification) plus the URL of the
    // control-plane send proxy. All bot-token operations happen control-plane-side. Only when the
    // operator has configured the shared app: legacy self-managed-app users are left untouched.
    // Anti-shadowing (as with EDEN_SANDBOX_ENV / EDEN_TEAM_*): delete user-set keys, then set.
    const discord = getDiscordAppConfig();
    if (discord) {
      for (const key of [
        "DISCORD_BOT_TOKEN",
        "DISCORD_APPLICATION_ID",
        "DISCORD_PUBLIC_KEY",
        "EDEN_DISCORD_SEND_URL",
      ]) {
        delete envVars[key];
      }
      envVars.DISCORD_APPLICATION_ID = discord.applicationId;
      envVars.DISCORD_PUBLIC_KEY = discord.publicKey;
      // Same control-plane base-URL derivation as EDEN_TEAM_URL above.
      const controlPlaneBase =
        process.env.EDEN_TEAM_RELAY_URL ??
        `http://host.docker.internal:${process.env.PORT ?? (process.env.NODE_ENV === "production" ? "3000" : "5173")}`;
      envVars.EDEN_DISCORD_SEND_URL = `${controlPlaneBase}/api/discord/send`;
      // The send proxy authenticates the CALLER DEPLOYMENT with the same delegation token the
      // team relay uses, so single-agent deployments (not team members — no EDEN_TEAM_* above)
      // need one too. The team relay independently authorizes, so this grants no team powers.
      envVars.EDEN_TEAM_TOKEN ??= mintDelegationToken(dep.id);
    }

    // Auth-brokered connections (issue #30): if this agent has an active Google grant, inject the
    // operator client creds + sealed refresh token so the shipped eve OpenAPI connection can
    // self-refresh access tokens at runtime. The provider validates the grant once (a dead grant
    // THROWS here, failing the deploy with a reconnect message). Eden OWNS these keys only when it
    // actually brokers the connection: like the Discord block above, anti-shadowing runs ONLY when
    // there's injection env — so a self-hoster's manually-set GOOGLE_OAUTH_* (their own client +
    // token, no broker) passes through untouched. No-op when there's no grant / no operator config.
    // Deploy-time scope coverage (issue #69): the committed lock at THIS release's commit names the
    // scopes the installed connectors require. Best-effort — a lock-fetch hiccup must never block a
    // deploy, and coverage is simply skipped (the grant liveness check still runs). Attribution
    // matches the loader's: a team member is keyed by name, the single-agent root by null.
    let requiredGoogleScopes: string | null = null;
    try {
      if (deps.agentLock && project?.repoOwner && project.repoName && project.repoInstallationId) {
        const lockJson = await deps.agentLock({
          installationId: project.repoInstallationId,
          owner: project.repoOwner,
          repo: project.repoName,
          ref: release.gitSha,
        });
        const lock = overlayLock(lockJson, []);
        const member = isTeamMember && agent ? agent.name : null;
        requiredGoogleScopes = requiredScopesByProvider(lock, member).get("google")?.join(" ") ?? null;
      }
    } catch {
      requiredGoogleScopes = null; // best-effort: never block a deploy on a lock-fetch hiccup
    }
    const grantEnv = deps.connectionGrantEnv
      ? await deps.connectionGrantEnv(scope, requiredGoogleScopes)
      : {};
    if (Object.keys(grantEnv).length > 0) {
      for (const key of [
        "GOOGLE_OAUTH_CLIENT_ID",
        "GOOGLE_OAUTH_CLIENT_SECRET",
        "GOOGLE_OAUTH_REFRESH_TOKEN",
      ]) {
        delete envVars[key];
      }
      for (const [key, value] of Object.entries(grantEnv)) {
        envVars[key] = value;
      }
    }

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
        injectTeammateTool: isTeamMember,
      });
      imageRef = built.imageRef;
      await store.releases.setImageRef(release.id, built.imageRef);
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
    await scheduleDeploymentContainerCleanup(
      store,
      superseded.map((d) => d.id),
    );
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
