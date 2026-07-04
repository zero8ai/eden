/**
 * Read eve repos through a GitHub App installation.
 *
 * Produces the `AgentSource` the pure parser consumes. We read the default-branch tree once
 * (recursive) and pull the handful of text files the read-only view needs (instructions.md,
 * agent.ts). Nothing here mutates the repo — Connect/visualize is read-only in M0; writes
 * (branch -> PR) come in M1.
 *
 * We also surface the repo-root `eden-lock.json` (marketplace install provenance, PRD §7.8) in
 * the tree + eager reads when present: the Deployment tab and the install wizard both need the
 * lock, and folding it into this one cached read spares them a separate ~600ms round trip. It
 * sits OUTSIDE every agent root, so the prefix-based parser (`detectAgentRoots`,
 * `buildAgentConfig`) never sees it — it's carried in `paths`/`files` for lock-aware callers only.
 */
import { AGENT_ROOT, TEAM_ROOT, detectAgentRoots, type AgentSource } from "~/eve/parse";
import { getInstallationOctokit } from "./client.server";

/** Repo-root marketplace install ledger (PRD §7.8) — carried alongside the agent tree. */
const EDEN_LOCK = "eden-lock.json";

export interface InstallationRepo {
  owner: string;
  repo: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
}

/** Current head commit SHA of a branch (default branch if omitted) — used to cut a Release. */
export async function getBranchHead(
  installationId: string | number,
  { owner, repo, ref }: { owner: string; repo: string; ref?: string },
): Promise<{ sha: string; branch: string }> {
  const octokit = await getInstallationOctokit(installationId);
  const branch =
    ref ?? (await octokit.rest.repos.get({ owner, repo })).data.default_branch;
  const res = await octokit.rest.repos.getBranch({ owner, repo, branch });
  return { sha: res.data.commit.sha, branch };
}

/** Repos this installation can access, for the connect picker. */
export async function listInstallationRepos(
  installationId: string | number,
): Promise<InstallationRepo[]> {
  const octokit = await getInstallationOctokit(installationId);
  const repos = await octokit.paginate(
    "GET /installation/repositories",
    { per_page: 100 },
  );
  return repos
    .map((r) => ({
      owner: r.owner.login,
      repo: r.name,
      fullName: r.full_name,
      defaultBranch: r.default_branch,
      private: r.private,
    }))
    .sort((a, b) => a.fullName.localeCompare(b.fullName));
}

interface RepoRef {
  owner: string;
  repo: string;
  /** Branch/ref to read; defaults to the repo's default branch. */
  ref?: string;
}

/**
 * Fetch the repo listing (under `agent/` for single-agent repos, `agents/` for teams) plus
 * known file contents — instructions.md and agent.ts for every detected agent root. Returns
 * the ref actually read and whether the git tree was truncated (very large repos), so
 * callers can surface it.
 */
export async function fetchAgentSource(
  installationId: string | number,
  { owner, repo, ref }: RepoRef,
): Promise<AgentSource & { ref: string; truncated: boolean }> {
  const octokit = await getInstallationOctokit(installationId);

  const branch =
    ref ??
    (await octokit.rest.repos.get({ owner, repo })).data.default_branch;

  const tree = await octokit.rest.git.getTree({
    owner,
    repo,
    tree_sha: branch,
    recursive: "true",
  });

  const agentPrefix = `${AGENT_ROOT}/`;
  const teamPrefix = `${TEAM_ROOT}/`;
  const paths = tree.data.tree.flatMap((e) =>
    e.type === "blob" &&
    typeof e.path === "string" &&
    (e.path === AGENT_ROOT ||
      e.path === EDEN_LOCK ||
      e.path.startsWith(agentPrefix) ||
      e.path.startsWith(teamPrefix))
      ? [e.path]
      : [],
  );

  const eager = [
    ...detectAgentRoots(paths).flatMap(({ root }) => [
      `${root}/instructions.md`,
      `${root}/agent.ts`,
    ]),
    EDEN_LOCK,
  ];
  const files: Record<string, string> = {};
  await Promise.all(
    eager.flatMap((path) =>
      paths.includes(path)
        ? [
            readTextFile(octokit, { owner, repo, ref: branch }, path).then((content) => {
              if (content !== null) files[path] = content;
            }),
          ]
        : [],
    ),
  );

  return { paths, files, ref: branch, truncated: Boolean(tree.data.truncated) };
}

type InstallationOctokit = Awaited<ReturnType<typeof getInstallationOctokit>>;

/** Last-commit metadata for one path (the resource list's "last updated / by" columns). */
export interface LastCommitInfo {
  authorLogin: string | null;
  authorName: string | null;
  date: string | null;
  sha: string;
}

/**
 * Last commit touching each path, for resource list metadata. One commits-API call per
 * path (GitHub has no batch form), run with a small concurrency cap; failures degrade to
 * a missing entry — the list must render fine without metadata (staged-new files have
 * none by definition).
 */
export async function fetchLastCommitForPaths(
  installationId: string | number,
  { owner, repo, ref }: RepoRef,
  paths: string[],
): Promise<Record<string, LastCommitInfo>> {
  const octokit = await getInstallationOctokit(installationId);
  const out: Record<string, LastCommitInfo> = {};
  const queue = [...paths];
  const CONCURRENCY = 8;

  async function worker() {
    for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
      try {
        const res = await octokit.rest.repos.listCommits({
          owner,
          repo,
          path,
          per_page: 1,
          ...(ref ? { sha: ref } : {}),
        });
        const c = res.data[0];
        if (c) {
          out[path] = {
            authorLogin: c.author?.login ?? null,
            authorName: c.commit.author?.name ?? null,
            date: c.commit.author?.date ?? null,
            sha: c.sha,
          };
        }
      } catch {
        // metadata is best-effort
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return out;
}

/**
 * Read one text file from the repo (default branch unless `ref` given). Public entry for
 * editors that need a single file's current contents; returns null if missing/binary.
 */
export async function readAgentFile(
  installationId: string | number,
  { owner, repo, ref }: RepoRef,
  path: string,
): Promise<string | null> {
  const octokit = await getInstallationOctokit(installationId);
  const branch =
    ref ?? (await octokit.rest.repos.get({ owner, repo })).data.default_branch;
  return readTextFile(octokit, { owner, repo, ref: branch }, path);
}

/** Read a single text file's contents, or null if missing/binary. */
async function readTextFile(
  octokit: InstallationOctokit,
  { owner, repo, ref }: Required<RepoRef>,
  path: string,
): Promise<string | null> {
  try {
    const res = await octokit.rest.repos.getContent({ owner, repo, path, ref });
    const data = res.data;
    if (Array.isArray(data) || data.type !== "file" || !("content" in data)) {
      return null;
    }
    return Buffer.from(data.content, "base64").toString("utf8");
  } catch {
    return null;
  }
}
