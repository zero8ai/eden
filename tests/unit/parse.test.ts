/**
 * Repo-layout detection (PRD §7.9): `agent/` at the root is a single-agent repo;
 * `agents/<member>/agent/` directories form a team roster. Pins the convention so init,
 * connect validation, and the project view all agree on what a repo is.
 */
import { describe, expect, it } from "vitest";

import {
  buildAgentConfig,
  detectAgentRoots,
  isEveRepo,
} from "~/eve/parse";

const SINGLE = [
  "agent/instructions.md",
  "agent/agent.ts",
  "agent/tools/example.ts",
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
    expect(detectAgentRoots(SINGLE)).toEqual([{ name: "agent", root: "agent" }]);
  });

  it("detects team members by the agents/<member>/agent convention, sorted", () => {
    expect(detectAgentRoots(TEAM)).toEqual([
      { name: "deployer", root: "agents/deployer/agent" },
      { name: "product-manager", root: "agents/product-manager/agent" },
    ]);
  });

  it("ignores agents/ entries without an inner agent/ directory", () => {
    expect(detectAgentRoots(["agents/notes.md", "agents/x/README.md"])).toEqual([]);
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
    expect(config.tools.map((t) => t.name)).toEqual(["example"]);
  });
});

describe("withPreservedNames", () => {
  it("keeps the human-given name for the root-layout member", async () => {
    const { withPreservedNames } = await import("~/db/queries.server");
    const existing = [
      { id: "a1", projectId: "p", name: "pm", root: "agent", createdAt: new Date(), updatedAt: new Date() },
    ];
    expect(withPreservedNames(existing, [{ name: "agent", root: "agent" }])).toEqual([
      { name: "pm", root: "agent" },
    ]);
    // Team members are named by directory — untouched.
    expect(
      withPreservedNames(existing, [{ name: "qa", root: "agents/qa/agent" }]),
    ).toEqual([{ name: "qa", root: "agents/qa/agent" }]);
  });
});
