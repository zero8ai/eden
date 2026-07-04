/**
 * Ship — the one-click deploy pipeline (quick path over the existing rails, PRD §7.3/§7.7).
 *
 * shipStagedChanges chains what the Changes + Deployments pages do manually: publish ALL
 * staged drafts as one change request, merge it immediately, cut Releases at the merge commit
 * (one per roster member, via the same idempotent path the GitHub webhook uses), and queue a
 * deploy into each AFFECTED member's chosen environment. The publish build-gate still applies:
 * a change-set that doesn't compile creates nothing and the drafts stay staged.
 *
 * shipHead covers the no-drafts case ("Ship latest from main"): cut-or-reuse a Release at the
 * branch head and deploy it for every roster member — absorbing the old "Cut release" button.
 *
 * Everything is deps-injectable in the publishDrafts style so unit tests run with zero I/O.
 */
import type { Agent, DataStore, Release } from "~/data/ports";
import { publishDrafts, type CheckBuildFn, type ProposeFn } from "~/drafts/drafts.server";
import { getBranchHead } from "~/github/repo.server";
import { mergePullRequest } from "~/github/write.server";
import { getRuntime } from "~/seams/index.server";
import { ensureReleasesForCommit, queueDeploy } from "./controller.server";

export interface ShipProject {
  id: string;
  repoInstallationId: string;
  repoOwner: string;
  repoName: string;
  defaultBranch: string;
}

export interface ShipResult {
  /** Version label of the shipped release (first member's — labels can differ per member). */
  version: string;
  /** The shipped commit — the version identity shared by every member's release (D9). */
  gitSha: string;
  envName: string;
  /** One entry per member whose environment got a queued deploy. */
  deployed: { agentName: string; environmentId: string; deploymentId: string }[];
  /**
   * Target members that have NO environment named `envName` (environments are per-agent and
   * user-defined, so names can diverge across a roster). Surfaced so a team ship never
   * silently half-lands.
   */
  skipped: { agentName: string }[];
}

export type MergeFn = typeof mergePullRequest;
export type BranchHeadFn = typeof getBranchHead;

export interface ShipDeps {
  store?: DataStore;
  propose?: ProposeFn;
  checkBuild?: CheckBuildFn;
  merge?: MergeFn;
  branchHead?: BranchHeadFn;
}

/**
 * Ship every staged draft to `envName`: publish → merge → release → queue deploys. Throws
 * before creating anything when there is nothing staged or the build-gate fails; throws after
 * the merge only if release-cutting fails (deploy failures are async, on the deployment rows).
 */
export async function shipStagedChanges(
  input: {
    project: ShipProject;
    envName: string;
    createdBy?: string | null;
  },
  deps: ShipDeps = {},
): Promise<ShipResult> {
  const store = deps.store ?? getRuntime().data;
  const merge = deps.merge ?? mergePullRequest;
  const { project, envName } = input;

  const drafts = await store.drafts.listByProject(project.id);
  if (drafts.length === 0) throw new Error("Nothing staged to ship.");
  // Capture who the drafts belong to BEFORE publishing deletes them. A shared draft
  // (agentId null — e.g. root package.json) affects every member.
  const affectsAll = drafts.some((d) => d.agentId === null);
  const affectedIds = new Set(drafts.map((d) => d.agentId).filter((a): a is string => !!a));

  const title =
    drafts.length === 1
      ? `Ship ${drafts[0].path}`
      : `Ship ${drafts.length} staged changes`;
  const change = await publishDrafts(
    { project, paths: drafts.map((d) => d.path), title, createdBy: input.createdBy },
    store,
    deps.propose,
    deps.checkBuild,
  );
  const { mergeSha } = await merge(
    project.repoInstallationId,
    { owner: project.repoOwner, repo: project.repoName },
    change.pullRequestNumber,
    change.branch,
  );
  const releases = await ensureReleasesForCommit(
    {
      projectId: project.id,
      gitSha: mergeSha,
      changelog: `#${change.pullRequestNumber} ${title}`,
      createdBy: input.createdBy,
    },
    store,
  );

  const roster = await store.agents.listByProject(project.id);
  const targets = affectsAll ? roster : roster.filter((a) => affectedIds.has(a.id));
  return deployToMembers({
    store,
    targets,
    releases: releases.map((r) => r.release),
    gitSha: mergeSha,
    envName,
    createdBy: input.createdBy,
  });
}

/**
 * Ship whatever is at the default branch head to `envName` for the whole roster. Idempotent
 * with prior ships of the same commit (release + image are reused — no rebuild).
 */
export async function shipHead(
  input: {
    project: ShipProject;
    envName: string;
    createdBy?: string | null;
  },
  deps: ShipDeps = {},
): Promise<ShipResult> {
  const store = deps.store ?? getRuntime().data;
  const branchHead = deps.branchHead ?? getBranchHead;
  const { project, envName } = input;

  const head = await branchHead(project.repoInstallationId, {
    owner: project.repoOwner,
    repo: project.repoName,
  });
  const releases = await ensureReleasesForCommit(
    {
      projectId: project.id,
      gitSha: head.sha,
      changelog: `Ship from ${head.branch} @ ${head.sha.slice(0, 7)}`,
      createdBy: input.createdBy,
    },
    store,
  );
  const roster = await store.agents.listByProject(project.id);
  return deployToMembers({
    store,
    targets: roster,
    releases: releases.map((r) => r.release),
    gitSha: head.sha,
    envName,
    createdBy: input.createdBy,
  });
}

/** Queue one deploy per target member into its environment named `envName` (if it has one). */
async function deployToMembers(input: {
  store: DataStore;
  targets: Agent[];
  releases: Release[];
  gitSha: string;
  envName: string;
  createdBy?: string | null;
}): Promise<ShipResult> {
  const { store, envName } = input;
  const deployed: ShipResult["deployed"] = [];
  const skipped: ShipResult["skipped"] = [];
  for (const agent of input.targets) {
    const release = input.releases.find((r) => r.agentId === agent.id);
    if (!release) continue;
    const envs = await store.environments.listByAgent(agent.id);
    const env = envs.find((e) => e.name === envName);
    if (!env) {
      skipped.push({ agentName: agent.name });
      continue;
    }
    const dep = await queueDeploy(
      { environmentId: env.id, releaseId: release.id, createdBy: input.createdBy },
      store,
    );
    deployed.push({ agentName: agent.name, environmentId: env.id, deploymentId: dep.id });
  }
  if (deployed.length === 0) {
    throw new Error(`No "${envName}" environment found to deploy into.`);
  }
  return {
    version: input.releases[0]?.version ?? "",
    gitSha: input.gitSha,
    envName,
    deployed,
    skipped,
  };
}
