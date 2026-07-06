/**
 * Repo-layout detection (PRD §7.9): `agent/` at the root is a single-agent repo;
 * `agents/<member>/agent/` directories form a team roster. Pins the convention so init,
 * connect validation, and the project view all agree on what a repo is.
 */
import { describe, expect, it } from "vitest";

import {
  buildAgentConfig,
  detectAgentRoots,
  detectSandbox,
  isEveRepo,
} from "~/eve/parse";

const SINGLE = [
  "agent/instructions.md",
  "agent/agent.ts",
  "agent/schedules/morning.md",
];

const TEAM = [
  "agents/product-manager/agent/instructions.md",
  "agents/product-manager/agent/agent.ts",
  "agents/product-manager/package.json",
  "agents/deployer/agent/agent.ts",
  "agents/deployer/agent/tools/cloudflare.ts",
  "eden.json",
];

describe("detectAgentRoots", () => {
  it("detects a single-agent repo as the one 'agent' root", () => {
    expect(detectAgentRoots(SINGLE)).toEqual([
      { name: "agent", root: "agent" },
    ]);
  });

  it("detects team members by the agents/<member>/agent convention, sorted", () => {
    expect(detectAgentRoots(TEAM)).toEqual([
      { name: "deployer", root: "agents/deployer/agent" },
      { name: "product-manager", root: "agents/product-manager/agent" },
    ]);
  });

  it("ignores agents/ entries without an inner agent/ directory", () => {
    expect(detectAgentRoots(["agents/notes.md", "agents/x/README.md"])).toEqual(
      [],
    );
  });

  it("prefers single-agent layout when both shapes exist", () => {
    expect(detectAgentRoots([...SINGLE, ...TEAM])).toEqual([
      { name: "agent", root: "agent" },
    ]);
  });
});

describe("isEveRepo", () => {
  it("accepts both layouts and rejects everything else", () => {
    expect(isEveRepo(SINGLE)).toBe(true);
    expect(isEveRepo(TEAM)).toBe(true);
    expect(isEveRepo(["src/index.ts", "README.md"])).toBe(false);
  });
});

describe("buildAgentConfig with a member root", () => {
  it("reads a team member's config from its own agent directory", () => {
    const config = buildAgentConfig(
      {
        paths: TEAM,
        files: {
          "agents/deployer/agent/agent.ts": `export default defineAgent({ model: "anthropic/claude-sonnet-5" });`,
        },
      },
      "agents/deployer/agent",
    );
    expect(config.hasAgentModule).toBe(true);
    expect(config.model).toBe("anthropic/claude-sonnet-5");
    expect(config.tools).toEqual([
      {
        name: "cloudflare",
        path: "agents/deployer/agent/tools/cloudflare.ts",
        isDirectory: false,
      },
    ]);
  });

  it("defaults to the single-agent root", () => {
    const config = buildAgentConfig({ paths: SINGLE, files: {} });
    expect(config.tools).toEqual([]);
    expect(config.schedules.map((t) => t.name)).toEqual(["morning"]);
  });
});

describe("detectSandbox", () => {
  it("detects the flat sandbox.<ext> shorthand under the agent root", () => {
    expect(detectSandbox([...SINGLE, "agent/sandbox.ts"], "agent")).toEqual({
      path: "agent/sandbox.ts",
      hasWorkspace: false,
    });
  });

  it("detects the sandbox/ folder layout, noting the workspace seed tree", () => {
    const paths = [
      ...SINGLE,
      "agent/sandbox/sandbox.ts",
      "agent/sandbox/workspace/notes/setup.md",
    ];
    expect(detectSandbox(paths, "agent")).toEqual({
      path: "agent/sandbox/sandbox.ts",
      hasWorkspace: true,
    });
  });

  it("prefers the folder layout when both exist (eve's discovery order)", () => {
    const paths = ["agent/sandbox.ts", "agent/sandbox/sandbox.js"];
    expect(detectSandbox(paths, "agent")).toEqual({
      path: "agent/sandbox/sandbox.js",
      hasWorkspace: false,
    });
  });

  it("returns null for the framework default, and ignores lookalike paths", () => {
    expect(detectSandbox(SINGLE, "agent")).toBeNull();
    // Not a sandbox module: wrong extension, nested under a category, or another agent's.
    expect(
      detectSandbox(
        [
          "agent/sandbox.md",
          "agent/tools/sandbox.ts",
          "agents/x/agent/sandbox.ts",
        ],
        "agent",
      ),
    ).toBeNull();
  });
});

describe("buildAgentConfig sandbox detection", () => {
  it("surfaces the root agent's sandbox and each subagent's own", () => {
    const paths = [
      ...SINGLE,
      "agent/sandbox.ts",
      "agent/subagents/researcher/instructions.md",
      "agent/subagents/researcher/sandbox.ts",
      "agent/subagents/writer/instructions.md",
    ];
    const config = buildAgentConfig({ paths, files: {} });
    expect(config.sandbox).toEqual({
      path: "agent/sandbox.ts",
      hasWorkspace: false,
    });
    expect(config.subagentSandboxes).toEqual({
      researcher: {
        path: "agent/subagents/researcher/sandbox.ts",
        hasWorkspace: false,
      },
    });
  });

  it("reports the framework default (null) when no definition exists", () => {
    const config = buildAgentConfig({ paths: SINGLE, files: {} });
    expect(config.sandbox).toBeNull();
    expect(config.subagentSandboxes).toEqual({});
  });

  it("scopes detection to the member's root in a team repo", () => {
    const config = buildAgentConfig(
      { paths: [...TEAM, "agents/deployer/agent/sandbox.ts"], files: {} },
      "agents/deployer/agent",
    );
    expect(config.sandbox).toEqual({
      path: "agents/deployer/agent/sandbox.ts",
      hasWorkspace: false,
    });
    const other = buildAgentConfig(
      { paths: [...TEAM, "agents/deployer/agent/sandbox.ts"], files: {} },
      "agents/product-manager/agent",
    );
    expect(other.sandbox).toBeNull();
  });
});

describe("withPreservedNames", () => {
  it("keeps the human-given name for the root-layout member", async () => {
    const { withPreservedNames } = await import("~/db/queries.server");
    const existing = [
      {
        id: "a1",
        projectId: "p",
        name: "pm",
        root: "agent",
        kind: "member",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    expect(
      withPreservedNames(existing, [{ name: "agent", root: "agent" }]),
    ).toEqual([{ name: "pm", root: "agent" }]);
    // Team members are named by directory — untouched.
    expect(
      withPreservedNames(existing, [{ name: "qa", root: "agents/qa/agent" }]),
    ).toEqual([{ name: "qa", root: "agents/qa/agent" }]);
  });
});
