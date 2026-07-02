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

/**
 * Commit `files` to `branch` as ONE commit via the Git Data API: blobs upload concurrently
 * (independent), then a single tree + commit + ref update. One change-set == one commit, and
 * no per-file sequential round-trips.
 */
export async function commitFiles(
  octokit: InstallationOctokit,
  { owner, repo }: RepoRef,
  branch: string,
  files: FileChange[],
  message: string,
): Promise<string> {
  const [blobs, head] = await Promise.all([
    Promise.all(
      files.map((f) =>
        octokit.rest.git.createBlob({
          owner,
          repo,
          content: Buffer.from(f.content, "utf8").toString("base64"),
          encoding: "base64",
        }),
      ),
    ),
    octokit.rest.git.getRef({ owner, repo, ref: `heads/${branch}` }),
  ]);
  const headSha = head.data.object.sha;
  const headCommit = await octokit.rest.git.getCommit({ owner, repo, commit_sha: headSha });
  const tree = await octokit.rest.git.createTree({
    owner,
    repo,
    base_tree: headCommit.data.tree.sha,
    tree: files.map((f, i) => ({
      path: f.path,
      mode: "100644" as const,
      type: "blob" as const,
      sha: blobs[i].data.sha,
    })),
  });
  const commit = await octokit.rest.git.createCommit({
    owner,
    repo,
    message,
    tree: tree.data.sha,
    parents: [headSha],
  });
  await octokit.rest.git.updateRef({
    owner,
    repo,
    ref: `heads/${branch}`,
    sha: commit.data.sha,
  });
  return commit.data.sha;
}

/**
 * Create a working branch, commit `files` (one commit), and open (or reuse) a PR back to the
 * base branch. Idempotent per branch name: calling again with the same branch stacks commits
 * and reuses the open PR.
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
  await commitFiles(octokit, ref, input.branch, input.files, input.commitMessage ?? input.title);

  return openOrReusePullRequest(octokit, ref, {
    base,
    branch: input.branch,
    title: input.title,
    body: input.body,
  });
}

/** A file touched by a change, with line deltas for a PM-readable diff summary. */
export interface ChangedFile {
  path: string;
  /** GitHub file status: added | modified | removed | renamed. */
  status: string;
  additions: number;
  deletions: number;
}

/** An open change-set (PR) awaiting review, with enough to review + merge it in-app. */
export interface OpenChange {
  number: number;
  title: string;
  /** PR body — the plain-language changelog Eden wrote. */
  body: string;
  url: string;
  branch: string;
  base: string;
  createdAt: string;
  /** null while GitHub is still computing mergeability. */
  mergeable: boolean | null;
  /** e.g. "clean", "dirty" (conflicts), "blocked", "unknown". */
  mergeableState: string;
  files: ChangedFile[];
}

/**
 * List open pull requests Eden opened for this repo (head branches under `eden/`), newest
 * first, each enriched with mergeability and its changed-file summary. This is the Changes
 * review inbox — the in-app surface that replaces bouncing to github.com to see/merge a PR.
 */
export async function listOpenChanges(
  installationId: string | number,
  { owner, repo }: RepoRef,
  limit = 20,
): Promise<OpenChange[]> {
  const octokit = await getInstallationOctokit(installationId);
  const list = await octokit.rest.pulls.list({
    owner,
    repo,
    state: "open",
    sort: "created",
    direction: "desc",
    per_page: 50,
  });
  // Only Eden-authored change-sets (our editors/assistant all branch under `eden/`).
  const edenPrs = list.data
    .filter((pr) => pr.head.ref.startsWith("eden/"))
    .slice(0, limit);

  return Promise.all(
    edenPrs.map(async (pr) => {
      // pulls.get returns the computed `mergeable`/`mergeable_state` the list omits.
      const [detail, files] = await Promise.all([
        octokit.rest.pulls.get({ owner, repo, pull_number: pr.number }),
        octokit.rest.pulls.listFiles({ owner, repo, pull_number: pr.number, per_page: 100 }),
      ]);
      return {
        number: pr.number,
        title: pr.title,
        body: pr.body ?? "",
        url: pr.html_url,
        branch: pr.head.ref,
        base: pr.base.ref,
        createdAt: pr.created_at,
        mergeable: detail.data.mergeable,
        mergeableState: detail.data.mergeable_state,
        files: files.data.map((f) => ({
          path: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
        })),
      } satisfies OpenChange;
    }),
  );
}

export interface MergeResult {
  /** The commit SHA on the base branch after merge — the canonical version identity (D9). */
  mergeSha: string;
  method: "squash" | "merge";
}

/**
 * Merge a change-set in-app (PRD §7.3: "merge in Eden or on GitHub"). Squash by default so
 * each change-set becomes exactly one commit on the default branch == one Release; falls back
 * to a merge commit if the repo disallows squash. Deletes the working branch on success.
 *
 * Throws a human-readable error when GitHub refuses the merge (conflicts / not mergeable) so
 * the Changes UI can tell the PM why rather than surfacing a raw 405/409.
 */
export async function mergePullRequest(
  installationId: string | number,
  { owner, repo }: RepoRef,
  pullNumber: number,
  branch?: string,
): Promise<MergeResult> {
  const octokit = await getInstallationOctokit(installationId);

  let method: "squash" | "merge" = "squash";
  let merged;
  try {
    merged = await octokit.rest.pulls.merge({
      owner,
      repo,
      pull_number: pullNumber,
      merge_method: method,
    });
  } catch (error) {
    const status = statusOf(error);
    // 405 with squash disabled on the repo — retry as a merge commit.
    if (status === 405) {
      method = "merge";
      try {
        merged = await octokit.rest.pulls.merge({
          owner,
          repo,
          pull_number: pullNumber,
          merge_method: method,
        });
      } catch (retryError) {
        throw mergeError(retryError);
      }
    } else {
      throw mergeError(error);
    }
  }

  // Best-effort branch cleanup; a failure here must not fail the (already-done) merge.
  const head = branch ?? (await octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber })).data.head.ref;
  if (head) {
    try {
      await octokit.rest.git.deleteRef({ owner, repo, ref: `heads/${head}` });
    } catch {
      // ignore — protected/already-deleted branch
    }
  }

  return { mergeSha: merged.data.sha, method };
}

/** Turn an Octokit merge failure into a PM-readable message. */
function mergeError(error: unknown): Error {
  const status = statusOf(error);
  if (status === 409 || status === 405) {
    return new Error(
      "This change can't be merged automatically — it conflicts with the current default branch. Re-open the change from a fresh edit, or resolve it in GitHub.",
    );
  }
  return error instanceof Error ? error : new Error(String(error));
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
