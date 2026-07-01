/**
 * Read eve repos through a GitHub App installation.
 *
 * Produces the `AgentSource` the pure parser consumes. We read the default-branch tree once
 * (recursive) and pull the handful of text files the read-only view needs (instructions.md,
 * agent.ts). Nothing here mutates the repo — Connect/visualize is read-only in M0; writes
 * (branch -> PR) come in M1.
 */
import { AGENT_ROOT, type AgentSource } from "~/eve/parse";
import { getInstallationOctokit } from "./client.server";

export interface InstallationRepo {
  owner: string;
  repo: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
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

/** Files we eagerly fetch contents for (relative to repo root). */
const EAGER_FILES = [`${AGENT_ROOT}/instructions.md`, `${AGENT_ROOT}/agent.ts`];

/**
 * Fetch the repo listing (under `agent/`) plus known file contents. Returns the ref actually
 * read and whether the git tree was truncated (very large repos), so callers can surface it.
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
  const paths = tree.data.tree
    .filter(
      (e) =>
        e.type === "blob" &&
        typeof e.path === "string" &&
        (e.path === AGENT_ROOT || e.path.startsWith(agentPrefix)),
    )
    .map((e) => e.path as string);

  const files: Record<string, string> = {};
  await Promise.all(
    EAGER_FILES.filter((p) => paths.includes(p)).map(async (path) => {
      const content = await readTextFile(octokit, { owner, repo, ref: branch }, path);
      if (content !== null) files[path] = content;
    }),
  );

  return { paths, files, ref: branch, truncated: Boolean(tree.data.truncated) };
}

type InstallationOctokit = Awaited<ReturnType<typeof getInstallationOctokit>>;

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
