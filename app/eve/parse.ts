/**
 * Pure parser: repo file listing + a few known file contents -> normalized AgentConfig.
 *
 * Kept free of any GitHub/IO coupling so it's trivially unit-testable and reusable across
 * DeployTargets (a local checkout can feed the same shape). The GitHub layer
 * (`app/github/repo.server.ts`) is responsible for producing `AgentSource`.
 */
import {
  AGENT_CATEGORIES,
  type AgentConfig,
  type AgentResource,
} from "./types";

/** Root directory that marks an eve agent. */
export const AGENT_ROOT = "agent";

export interface AgentSource {
  /** Every file path in the repo, repo-relative, forward-slashed. */
  paths: string[];
  /** Pre-fetched contents for a handful of known text files (by repo-relative path). */
  files: Record<string, string>;
}

/** True when the repo looks like an eve project (has an `agent/` directory). */
export function isEveRepo(paths: string[]): boolean {
  const prefix = `${AGENT_ROOT}/`;
  return paths.some((p) => p === AGENT_ROOT || p.startsWith(prefix));
}

/**
 * Collect the immediate children of `agent/<dir>/` as resources. A child is either a file
 * (`agent/tools/foo.ts` -> "foo") or a directory (`agent/skills/bar/skill.ts` -> "bar",
 * marked isDirectory). Deduped by name, sorted.
 */
function childrenOf(paths: string[], dir: string): AgentResource[] {
  const prefix = `${AGENT_ROOT}/${dir}/`;
  const byName = new Map<string, AgentResource>();

  for (const path of paths) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    if (!rest) continue;

    const slash = rest.indexOf("/");
    const isDirectory = slash !== -1;
    const segment = isDirectory ? rest.slice(0, slash) : rest;
    if (!segment) continue;

    // Skip test/spec files and dotfiles — they're not authored resources.
    if (!isDirectory && (/\.(test|spec)\.[cm]?[jt]sx?$/.test(segment) || segment.startsWith("."))) {
      continue;
    }

    const name = isDirectory ? segment : stripExtension(segment);
    if (byName.has(name)) continue;

    byName.set(name, {
      name,
      path: `${prefix}${segment}`,
      isDirectory,
    });
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function stripExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}

/**
 * Best-effort model id from `agent.ts`. eve agents commonly declare a model as a string
 * literal (e.g. `model: 'anthropic/claude-...'`); we grab the first such literal. This is a
 * heuristic for the read-only view, not a substitute for executing the module.
 */
export function extractModel(agentModuleSource: string | undefined): string | null {
  if (!agentModuleSource) return null;
  const match = agentModuleSource.match(
    /\bmodel\s*:\s*(['"`])([^'"`]+)\1/,
  );
  return match ? match[2] : null;
}

/** Build the normalized config from a repo listing + known file contents. */
export function buildAgentConfig(source: AgentSource): AgentConfig {
  const { paths, files } = source;

  const categories = Object.fromEntries(
    AGENT_CATEGORIES.map((c) => [c.key, childrenOf(paths, c.dir)]),
  ) as Pick<
    AgentConfig,
    "tools" | "skills" | "subagents" | "channels" | "schedules" | "connections"
  >;

  const agentModulePath = `${AGENT_ROOT}/agent.ts`;
  const instructionsPath = `${AGENT_ROOT}/instructions.md`;

  return {
    hasAgentModule: paths.includes(agentModulePath),
    model: extractModel(files[agentModulePath]),
    instructions: files[instructionsPath] ?? null,
    ...categories,
  };
}
