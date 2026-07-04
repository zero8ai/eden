/**
 * The authoring assistant runtime: an agent loop over OpenRouter chat completions with
 * repo-editing tools. The METHOD system prompt (method.ts) encodes how to work; this module
 * provides the hands: list/read files (draft-aware), stage drafts, add npm dependencies
 * (with a correctly regenerated lockfile), and run the same build gate a publish runs.
 *
 * Model key resolution (PRD §12): the workspace-level OpenRouter key from Org settings,
 * falling back to OPENROUTER_API_KEY in the server env. No ANTHROPIC_API_KEY anywhere.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { listDrafts, resolveFileView, stageDraft } from "~/drafts/drafts.server";
import { fetchAgentSource } from "~/github/repo.server";
import { getWorkspaceAssistantModel, getWorkspaceModelKey } from "~/org/workspace.server";
import type { ConnectedProject } from "~/project/guard.server";
import { normalizeAgentPath } from "~/project/guard.server";
import { getRuntime } from "~/seams/index.server";
import { METHOD } from "./method";

const exec = promisify(execFile);

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
/** Fallback when the org hasn't picked one (Org settings → Model provider). */
const DEFAULT_MODEL = process.env.EDEN_ASSISTANT_MODEL ?? "anthropic/claude-sonnet-5";
const MAX_STEPS = 24;

export interface AuthoringRunInput {
  project: ConnectedProject;
  instruction: string;
  createdBy: string;
  /** Prior model-level turns (no system message) — the conversation's memory. */
  history?: ChatMessage[];
}

export interface AuthoringRunResult {
  summary: string;
  /** Paths staged as drafts during the run. */
  files: string[];
  secretsNeeded: string[];
  /** Result of the last run_checks call, if any. */
  checks: { ran: boolean; ok: boolean; output?: string };
  /** Updated model-level history to persist for the next turn. */
  history: ChatMessage[];
}

// ── OpenAI-format tool declarations (OpenRouter tool calling) ────────────────

const TOOLS = [
  {
    type: "function",
    function: {
      name: "list_files",
      description:
        "List the agent's files: everything under agent/ plus package.json. Staged (unpublished) drafts are marked.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a file's current content — a staged draft if one exists, else the pending change request version, else the repo.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "repo-relative path" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Stage the full new contents of a file as a draft (create or overwrite). Not for package.json/package-lock.json — use add_dependency.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "repo-relative path under agent/" },
          content: { type: "string", description: "the complete file contents" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_dependency",
      description:
        "Add npm packages to the agent project. Updates package.json and regenerates package-lock.json; both are staged as drafts.",
      parameters: {
        type: "object",
        properties: {
          packages: {
            type: "array",
            items: { type: "string" },
            description: 'package specs, e.g. ["discord.js@14"] or ["pg"]',
          },
        },
        required: ["packages"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_checks",
      description:
        "Compile-check the project with all staged drafts applied: installs dependencies, runs eve build, then the repo's typecheck/lint scripts if present. Returns ok or the errors to fix.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "finish",
      description:
        "End the session. Call only when checks pass (or nothing was changed). Summarize for a non-developer and list every secret the code reads.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string" },
          secretsNeeded: { type: "array", items: { type: "string" } },
        },
        required: ["summary", "secretsNeeded"],
      },
    },
  },
];

// ── Tool implementations ─────────────────────────────────────────────────────

type ToolResult = string;

async function listFiles(project: ConnectedProject): Promise<ToolResult> {
  const [source, drafts] = await Promise.all([
    fetchAgentSource(project.repoInstallationId, {
      owner: project.repoOwner,
      repo: project.repoName,
    }),
    listDrafts(project.id),
  ]);
  const staged = new Set(drafts.map((d) => d.path));
  const paths = new Set([...source.paths, "package.json", ...staged]);
  return [...paths]
    .sort()
    .map((p) => (staged.has(p) ? `${p}  [staged draft]` : p))
    .join("\n");
}

async function readRepoFile(
  project: ConnectedProject,
  rawPath: string,
): Promise<ToolResult> {
  const p = normalizeAgentPath(rawPath);
  if (!p) return `ERROR: path not editable/readable from Eden: ${rawPath}`;
  const view = await resolveFileView(project, p);
  if (view.content === null) return `ERROR: ${p} does not exist.`;
  return view.content;
}

async function writeRepoFile(
  project: ConnectedProject,
  createdBy: string,
  rawPath: string,
  content: string,
  staged: string[],
): Promise<ToolResult> {
  const p = normalizeAgentPath(rawPath);
  if (!p) return `ERROR: files must live under agent/ (got: ${rawPath})`;
  if (p === "package.json" || p === "package-lock.json") {
    return "ERROR: use add_dependency for dependency changes — never write the manifest directly.";
  }
  await stageDraft({ projectId: project.id, path: p, content, createdBy });
  if (!staged.includes(p)) staged.push(p);
  return `Staged ${p} (${content.length} chars).`;
}

/**
 * npm resolves the new dependency set in a scratch dir (--package-lock-only: no node_modules,
 * registry metadata only), then both manifests are staged. This is the only correct way to
 * change dependencies — a hand-edited lockfile fails `npm ci` at build time.
 */
async function addDependency(
  project: ConnectedProject,
  createdBy: string,
  packages: string[],
  staged: string[],
): Promise<ToolResult> {
  if (packages.length === 0) return "ERROR: no packages given.";
  if (packages.some((p) => !/^(@?[\w.-]+\/)?[\w.-]+(@[\w^~><=.*-]+)?$/.test(p))) {
    return `ERROR: invalid package spec in: ${packages.join(", ")}`;
  }
  const [pkgView, lockView] = await Promise.all([
    resolveFileView(project, "package.json"),
    resolveFileView(project, "package-lock.json"),
  ]);
  if (pkgView.content === null) return "ERROR: the repo has no package.json.";

  const dir = await mkdtemp(path.join(tmpdir(), "eden-deps-"));
  try {
    await writeFile(path.join(dir, "package.json"), pkgView.content);
    if (lockView.content !== null) {
      await writeFile(path.join(dir, "package-lock.json"), lockView.content);
    }
    await exec(
      "npm",
      ["install", ...packages, "--package-lock-only", "--no-audit", "--no-fund"],
      { cwd: dir, timeout: 120_000 },
    );
    const [pkg, lock] = await Promise.all([
      readFile(path.join(dir, "package.json"), "utf8"),
      readFile(path.join(dir, "package-lock.json"), "utf8"),
    ]);
    await stageDraft({ projectId: project.id, path: "package.json", content: pkg, createdBy });
    await stageDraft({
      projectId: project.id,
      path: "package-lock.json",
      content: lock,
      createdBy,
    });
    for (const p of ["package.json", "package-lock.json"]) {
      if (!staged.includes(p)) staged.push(p);
    }
    return `Added ${packages.join(", ")}; package.json and package-lock.json staged.`;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return `ERROR: npm could not resolve ${packages.join(", ")}: ${msg.split("\n").slice(0, 6).join("\n")}`;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runChecks(
  project: ConnectedProject,
  lastChecks: AuthoringRunResult["checks"],
): Promise<ToolResult> {
  const target = getRuntime().deployTarget;
  if (!target.checkBuild) {
    lastChecks.ran = true;
    lastChecks.ok = true;
    return "Checks unavailable on this deploy target (no local toolchain) — skipped. Proceed, but note it in your summary.";
  }
  const drafts = await listDrafts(project.id);
  const res = await target.checkBuild({
    projectId: project.id,
    repo: { owner: project.repoOwner, repo: project.repoName },
    ref: project.defaultBranch,
    installationId: project.repoInstallationId,
    overlay: drafts.map((d) => ({ path: d.path, content: d.content })),
  });
  lastChecks.ran = true;
  lastChecks.ok = res.ok;
  if (res.ok) return "All checks passed (build + typecheck/lint).";
  lastChecks.output = res.output;
  return `CHECKS FAILED — fix these and run again:\n${res.output}`;
}

// ── The loop ─────────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string;
}

async function resolveModelKey(orgId: string): Promise<string> {
  const wsKey = await getWorkspaceModelKey(orgId).catch(() => null);
  const key = wsKey ?? process.env.OPENROUTER_API_KEY;
  if (!key) {
    throw new Error(
      "No OpenRouter key configured. Add one in Org settings → Model provider (or set OPENROUTER_API_KEY in the server env).",
    );
  }
  return key;
}

async function chat(key: string, model: string, messages: ChatMessage[]): Promise<ChatMessage> {
  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      tools: TOOLS,
      tool_choice: "auto",
      max_tokens: 8192,
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenRouter ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    choices: { message: ChatMessage }[];
    error?: { message?: string };
  };
  const message = data.choices?.[0]?.message;
  if (!message) throw new Error(data.error?.message ?? "OpenRouter returned no choices.");
  return message;
}

/** Run one authoring session: instruction in, staged drafts + summary out. */
export async function runAuthoringAgent(
  input: AuthoringRunInput,
): Promise<AuthoringRunResult> {
  const { project, instruction, createdBy } = input;
  const key = await resolveModelKey(project.orgId);
  const model =
    (await getWorkspaceAssistantModel(project.orgId).catch(() => null)) ?? DEFAULT_MODEL;

  const staged: string[] = [];
  const checks: AuthoringRunResult["checks"] = { ran: false, ok: false };

  // The system prompt is prepended fresh each run (METHOD updates apply to old
  // conversations); the persisted history carries only the turns.
  const messages: ChatMessage[] = [
    { role: "system", content: METHOD },
    ...(input.history ?? []),
    { role: "user", content: instruction },
  ];
  const historyOut = () => trimHistory(messages.slice(1));

  for (let step = 0; step < MAX_STEPS; step++) {
    const reply = await chat(key, model, messages);
    messages.push(reply);

    if (!reply.tool_calls?.length) {
      // A prose reply is a conversational turn (answer, clarifying question) — valid.
      return {
        summary: reply.content ?? "Done.",
        files: staged,
        secretsNeeded: [],
        checks,
        history: historyOut(),
      };
    }

    for (const call of reply.tool_calls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {
        // leave args empty; the tool will report the problem
      }

      if (call.function.name === "finish") {
        messages.push({ role: "tool", content: "Session ended.", tool_call_id: call.id });
        return {
          summary: String(args.summary ?? "Done."),
          files: staged,
          secretsNeeded: Array.isArray(args.secretsNeeded)
            ? args.secretsNeeded.map(String)
            : [],
          checks,
          history: historyOut(),
        };
      }

      let result: string;
      try {
        switch (call.function.name) {
          case "list_files":
            result = await listFiles(project);
            break;
          case "read_file":
            result = await readRepoFile(project, String(args.path ?? ""));
            break;
          case "write_file":
            result = await writeRepoFile(
              project,
              createdBy,
              String(args.path ?? ""),
              String(args.content ?? ""),
              staged,
            );
            break;
          case "add_dependency":
            result = await addDependency(
              project,
              createdBy,
              Array.isArray(args.packages) ? args.packages.map(String) : [],
              staged,
            );
            break;
          case "run_checks":
            result = await runChecks(project, checks);
            break;
          default:
            result = `ERROR: unknown tool ${call.function.name}`;
        }
      } catch (error) {
        result = `ERROR: ${error instanceof Error ? error.message : String(error)}`;
      }
      messages.push({ role: "tool", content: result, tool_call_id: call.id });
    }
  }

  return {
    summary:
      "Stopped after the step limit. Files written so far are staged — review them in Changes.",
    files: staged,
    secretsNeeded: [],
    checks,
    history: historyOut(),
  };
}

const MAX_HISTORY_MESSAGES = 60;
const MAX_TOOL_RESULT_CHARS = 2_000;

/**
 * Bound what a conversation carries forward: big tool outputs (file contents, build logs)
 * are truncated — the assistant re-reads files when it needs them — and the tail is capped,
 * always cutting at a user message so assistant/tool call pairs stay intact.
 */
function trimHistory(history: ChatMessage[]): ChatMessage[] {
  let out = history.map((m) =>
    m.role === "tool" && m.content && m.content.length > MAX_TOOL_RESULT_CHARS
      ? { ...m, content: `${m.content.slice(0, MAX_TOOL_RESULT_CHARS)}
…[truncated]` }
      : m,
  );
  if (out.length > MAX_HISTORY_MESSAGES) {
    out = out.slice(-MAX_HISTORY_MESSAGES);
    while (out.length > 0 && out[0].role !== "user") out.shift();
  }
  return out;
}
