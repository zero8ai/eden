/**
 * The eve agent config surface Eden reads out of a repo.
 *
 * An eve agent lives under `agent/` in the repo (D3 — the repo is the source of truth):
 * `instructions.md`, `agent.ts`, and directories `tools/`, `skills/`, `subagents/`,
 * `channels/`, `schedules/`, `connections/`. This type is the normalized, UI-friendly shape
 * we render read-only in M0 and, later, edit in M1.
 *
 * Shared client/server (no server-only imports) so route components can type `loaderData`.
 */

/** A file- or directory-backed named resource inside the agent (e.g. a tool, a channel). */
export interface AgentResource {
  /** Display name — the file basename (sans extension) or directory name. */
  name: string;
  /** Repo-relative path to the file or directory. */
  path: string;
  /** True when the resource is a directory (skills/subagents are usually folders). */
  isDirectory: boolean;
}

/**
 * The authored sandbox definition for an agent (or subagent) — a singleton like
 * instructions, not a directory category. eve accepts `sandbox.<ext>` directly under the
 * agent root, or a `sandbox/` folder owning `sandbox/sandbox.<ext>` plus an optional
 * `workspace/` seed tree. Absent = eve's framework default sandbox.
 */
export interface AgentSandbox {
  /** Repo-relative path to the definition module (`…/sandbox.ts` or `…/sandbox/sandbox.ts`). */
  path: string;
  /** True when the folder layout carries a `sandbox/workspace/` seed tree. */
  hasWorkspace: boolean;
}

/** The eve concepts we surface. Keyed so the UI can iterate categories generically. */
export interface AgentConfig {
  /** Whether `agent/agent.ts` exists (the agent entrypoint module). */
  hasAgentModule: boolean;
  /** Best-effort model id parsed from `agent.ts` (heuristic; null if not found). */
  model: string | null;
  /** Contents of `agent/instructions.md`, or null when absent. */
  instructions: string | null;
  /** The agent's own sandbox definition, or null when it runs eve's framework default. */
  sandbox: AgentSandbox | null;
  /** Subagent sandbox definitions by subagent name (each subagent owns its own sandbox). */
  subagentSandboxes: Record<string, AgentSandbox>;
  tools: AgentResource[];
  skills: AgentResource[];
  subagents: AgentResource[];
  channels: AgentResource[];
  schedules: AgentResource[];
  connections: AgentResource[];
}

/** The categories, in display order, with the subdirectory each maps to under `agent/`. */
export const AGENT_CATEGORIES = [
  { key: "tools", dir: "tools", label: "Tools" },
  { key: "skills", dir: "skills", label: "Skills" },
  { key: "subagents", dir: "subagents", label: "Subagents" },
  { key: "channels", dir: "channels", label: "Channels" },
  { key: "schedules", dir: "schedules", label: "Schedules" },
  { key: "connections", dir: "connections", label: "Connections" },
] as const satisfies ReadonlyArray<{
  key: keyof Pick<
    AgentConfig,
    "tools" | "skills" | "subagents" | "channels" | "schedules" | "connections"
  >;
  dir: string;
  label: string;
}>;
