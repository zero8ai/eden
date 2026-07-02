/**
 * Create a new eve repo and scaffold it (Connect pillar — the "create new" path, PRD §7.1).
 *
 * This is Eden's headless equivalent of `eve init`: create the repo via the GitHub App, then
 * commit an eve agent skeleton (`agent/` + package manifest) directly to the default branch.
 * (The PRD flags "eve init headless" as a spike — we scaffold a faithful minimal skeleton
 * rather than shelling the interactive TUI; swap to a real `eve init` invocation once the
 * deploy controller has a build environment.)
 *
 * GitHub Apps create repos under an **organization** installation (`repos.createInOrg`).
 * Personal-account creation isn't available via an installation token, so that path returns a
 * clear error pointing the user at "connect an existing repo".
 */
import { scaffoldAgentModule } from "~/eve/agentModule";
import { commitFiles, type FileChange } from "./write.server";
import { getInstallationOctokit } from "./client.server";

export interface CreateRepoInput {
  owner: string;
  name: string;
  private?: boolean;
  description?: string;
  model?: string;
}

export interface CreatedRepo {
  owner: string;
  repo: string;
  defaultBranch: string;
  htmlUrl: string;
}

const DEFAULT_MODEL = "anthropic/claude-sonnet-5";

/** The files that make up a fresh eve agent skeleton. */
function scaffoldFiles(name: string, model: string): FileChange[] {
  return [
    {
      path: "agent/instructions.md",
      content: `# ${name}\n\nYou are a helpful agent. Describe the agent's role, tone, and\nboundaries here — this Markdown is the always-on system prompt.\n`,
    },
    { path: "agent/agent.ts", content: scaffoldAgentModule(model) },
    {
      path: "agent/tools/example.ts",
      content: `import { defineTool } from 'eve';\nimport { z } from 'zod';\n\nexport default defineTool({\n  description: 'An example tool. Replace with your own.',\n  inputSchema: z.object({\n    name: z.string().describe('Who to greet'),\n  }),\n  async execute({ name }) {\n    return \`Hello, \${name}!\`;\n  },\n});\n`,
    },
    {
      path: "package.json",
      content:
        JSON.stringify(
          {
            name,
            private: true,
            type: "module",
            scripts: { dev: "eve dev", build: "eve build" },
            dependencies: { eve: "latest", zod: "^3.23.0" },
          },
          null,
          2,
        ) + "\n",
    },
    {
      path: "README.md",
      content: `# ${name}\n\nAn [eve](https://github.com/vercel/eve) agent scaffolded by Eden. The agent\nlives under \`agent/\`. Edit it here or in Eden.\n`,
    },
    {
      path: ".gitignore",
      content: ".eve/\n.output/\n.workflow-data/\nnode_modules/\n.env\n.env.*\n",
    },
  ];
}

/** Create the org repo (auto-initialized) and commit the eve skeleton to its default branch. */
export async function createEveRepo(
  installationId: string | number,
  input: CreateRepoInput,
): Promise<CreatedRepo> {
  const octokit = await getInstallationOctokit(installationId);

  let created;
  try {
    created = await octokit.rest.repos.createInOrg({
      org: input.owner,
      name: input.name,
      private: input.private ?? true,
      auto_init: true,
      description: input.description ?? "An eve agent, built with Eden.",
    });
  } catch (error) {
    const status =
      typeof error === "object" && error && "status" in error
        ? (error as { status?: number }).status
        : undefined;
    if (status === 404) {
      throw new Error(
        `Couldn't create a repo under "${input.owner}". The GitHub App can only create ` +
          `repos in an organization it's installed on. To use a personal account, create the ` +
          `repo on GitHub first, then connect it.`,
      );
    }
    throw error;
  }

  const repo = created.data;
  const branch = repo.default_branch;

  // Commit the skeleton directly to the default branch — a brand-new repo needs no PR.
  // One commit for the whole scaffold via the Git Data API (blobs upload in parallel).
  const files = scaffoldFiles(input.name, input.model ?? DEFAULT_MODEL);
  await commitFiles(
    octokit,
    { owner: input.owner, repo: input.name },
    branch,
    files,
    "chore: scaffold eve agent",
  );

  return {
    owner: input.owner,
    repo: input.name,
    defaultBranch: branch,
    htmlUrl: repo.html_url,
  };
}
