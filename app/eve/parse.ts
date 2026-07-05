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
/** Root directory that marks a team monorepo (PRD §7.9): `agents/<member>/agent/...`. */
export const TEAM_ROOT = "agents";

export interface AgentSource {
  /** Every file path in the repo, repo-relative, forward-slashed. */
  paths: string[];
  /** Pre-fetched contents for a handful of known text files (by repo-relative path). */
  files: Record<string, string>;
}

/** One member of the repo: its display name and the agent directory it lives under. */
export interface AgentRoot {
  /** "agent" for a single-agent repo; the member directory name for a team member. */
  name: string;
  /** Repo-relative agent directory, e.g. "agent" or "agents/product-manager/agent". */
  root: string;
}

/**
 * Detect the repo layout by convention (PRD §7.9): `agent/` at the root is a single-agent
 * repo; otherwise each `agents/<member>/agent/` directory is a team member. Single-agent
 * takes precedence so today's repos are unaffected by a stray `agents/` directory.
 */
export function detectAgentRoots(paths: string[]): AgentRoot[] {
  const singlePrefix = `${AGENT_ROOT}/`;
  if (paths.some((p) => p === AGENT_ROOT || p.startsWith(singlePrefix))) {
    return [{ name: AGENT_ROOT, root: AGENT_ROOT }];
  }

  const teamPrefix = `${TEAM_ROOT}/`;
  const members = new Map<string, AgentRoot>();
  for (const path of paths) {
    if (!path.startsWith(teamPrefix)) continue;
    const rest = path.slice(teamPrefix.length);
    const slash = rest.indexOf("/");
    if (slash <= 0) continue;
    const member = rest.slice(0, slash);
    const inner = rest.slice(slash + 1);
    if (inner === AGENT_ROOT || inner.startsWith(singlePrefix)) {
      members.set(member, { name: member, root: `${TEAM_ROOT}/${member}/${AGENT_ROOT}` });
    }
  }
  return [...members.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** True when the repo looks like an eve project — single-agent or team layout. */
export function isEveRepo(paths: string[]): boolean {
  return detectAgentRoots(paths).length > 0;
}

/**
 * Collect the immediate children of `<root>/<dir>/` as resources. A child is either a file
 * (`agent/tools/foo.ts` -> "foo") or a directory (`agent/skills/bar/skill.ts` -> "bar",
 * marked isDirectory). Deduped by name, sorted.
 */
function childrenOf(paths: string[], root: string, dir: string): AgentResource[] {
  const prefix = `${root}/${dir}/`;
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
function extractModel(agentModuleSource: string | undefined): string | null {
  if (!agentModuleSource) return null;
  // Provider-wrapped form first (`model: openrouter("...")`), then the bare literal —
  // the same order `readModel` in ~/eve/agentModule uses, so repo and draft views agree.
  const call = agentModuleSource.match(
    /\bmodel\s*:\s*[A-Za-z_$][\w$]*\(\s*(['"`])([^'"`]+)\1/,
  );
  if (call) return call[2];
  const match = agentModuleSource.match(
    /\bmodel\s*:\s*(['"`])([^'"`]+)\1/,
  );
  return match ? match[2] : null;
}

/**
 * Build the normalized config from a repo listing + known file contents. `root` selects
 * which agent directory to read — "agent" (default, single-agent repos) or a team member's
 * `agents/<name>/agent` (§7.9).
 */
export function buildAgentConfig(source: AgentSource, root: string = AGENT_ROOT): AgentConfig {
  const { paths, files } = source;

  const categories = Object.fromEntries(
    AGENT_CATEGORIES.map((c) => [c.key, childrenOf(paths, root, c.dir)]),
  ) as Pick<
    AgentConfig,
    "tools" | "skills" | "subagents" | "channels" | "schedules" | "connections"
  >;

  const agentModulePath = `${root}/agent.ts`;
  const instructionsPath = `${root}/instructions.md`;

  return {
    hasAgentModule: paths.includes(agentModulePath),
    model: extractModel(files[agentModulePath]),
    instructions: files[instructionsPath] ?? null,
    ...categories,
  };
}
