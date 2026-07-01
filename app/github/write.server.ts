/**
 * Git write layer (Author pillar, M1) — the one primitive every editor and the Pi assistant
 * use to ship a change.
 *
 * D3 is git-native: Eden never mutates the default branch directly. A change becomes a working
 * branch off the default branch, one or more file commits, and a pull request. Merging the PR
 * is the ship signal (later wired to deploy). The eve repo stays the single source of truth —
 * we persist nothing about the change locally; its state lives in GitHub.
 */
import { getInstallationOctokit } from "./client.server";

export interface FileChange {
  /** Repo-relative path, forward-slashed (e.g. "agent/instructions.md"). */
  path: string;
  /** New UTF-8 file contents. */
  content: string;
}

export interface ProposeChangeInput {
  /** Base branch to branch from and target the PR at; defaults to the repo default branch. */
  base?: string;
  /** Working branch name to create/reuse (e.g. "eden/edit-instructions-abc"). */
  branch: string;
  files: FileChange[];
  title: string;
  body?: string;
  /** Commit message; defaults to `title`. */
  commitMessage?: string;
}

export interface ProposedChange {
  branch: string;
  base: string;
  pullRequestUrl: string;
  pullRequestNumber: number;
  /** True when we reused an already-open PR for this branch rather than creating one. */
  reusedPullRequest: boolean;
}

interface RepoRef {
  owner: string;
  repo: string;
}

type InstallationOctokit = Awaited<ReturnType<typeof getInstallationOctokit>>;

/** HTTP status of an Octokit request error, if present. */
function statusOf(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error
    ? (error as { status?: number }).status
    : undefined;
}

/** Create the working branch off `baseSha`, tolerating "already exists". */
async function ensureBranch(
  octokit: InstallationOctokit,
  { owner, repo }: RepoRef,
  branch: string,
  baseSha: string,
): Promise<void> {
  try {
    await octokit.rest.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branch}`,
      sha: baseSha,
    });
  } catch (error) {
    // 422 == ref already exists; reuse it so repeated saves stack on one branch/PR.
    if (statusOf(error) !== 422) throw error;
  }
}

/** Current blob sha of `path` on `ref`, or undefined if the file doesn't exist yet. */
async function fileShaOnBranch(
  octokit: InstallationOctokit,
  { owner, repo }: RepoRef,
  path: string,
  ref: string,
): Promise<string | undefined> {
  try {
    const res = await octokit.rest.repos.getContent({ owner, repo, path, ref });
    const d = res.data;
    return Array.isArray(d) || !("sha" in d) ? undefined : d.sha;
  } catch (error) {
    if (statusOf(error) === 404) return undefined;
    throw error;
  }
}

/**
 * Create a working branch, commit `files`, and open (or reuse) a PR back to the base branch.
 * Idempotent per branch name: calling again with the same branch stacks commits and reuses
 * the open PR.
 */
export async function proposeChange(
  installationId: string | number,
  { owner, repo }: RepoRef,
  input: ProposeChangeInput,
): Promise<ProposedChange> {
  const octokit = await getInstallationOctokit(installationId);
  const ref: RepoRef = { owner, repo };

  const base =
    input.base ??
    (await octokit.rest.repos.get({ owner, repo })).data.default_branch;

  const baseRef = await octokit.rest.git.getRef({
    owner,
    repo,
    ref: `heads/${base}`,
  });
  await ensureBranch(octokit, ref, input.branch, baseRef.data.object.sha);

  for (const file of input.files) {
    const sha = await fileShaOnBranch(octokit, ref, file.path, input.branch);
    await octokit.rest.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: file.path,
      message: input.commitMessage ?? input.title,
      content: Buffer.from(file.content, "utf8").toString("base64"),
      branch: input.branch,
      ...(sha ? { sha } : {}),
    });
  }

  return openOrReusePullRequest(octokit, ref, {
    base,
    branch: input.branch,
    title: input.title,
    body: input.body,
  });
}

async function openOrReusePullRequest(
  octokit: InstallationOctokit,
  { owner, repo }: RepoRef,
  {
    base,
    branch,
    title,
    body,
  }: { base: string; branch: string; title: string; body?: string },
): Promise<ProposedChange> {
  try {
    const created = await octokit.rest.pulls.create({
      owner,
      repo,
      base,
      head: branch,
      title,
      body,
    });
    return {
      branch,
      base,
      pullRequestUrl: created.data.html_url,
      pullRequestNumber: created.data.number,
      reusedPullRequest: false,
    };
  } catch (error) {
    // 422 == a PR for this head already exists; find and return it.
    if (statusOf(error) !== 422) throw error;
    const existing = await octokit.rest.pulls.list({
      owner,
      repo,
      base,
      head: `${owner}:${branch}`,
      state: "open",
    });
    const pr = existing.data[0];
    if (!pr) throw error;
    return {
      branch,
      base,
      pullRequestUrl: pr.html_url,
      pullRequestNumber: pr.number,
      reusedPullRequest: true,
    };
  }
}
