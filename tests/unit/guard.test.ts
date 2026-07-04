/**
 * Path guard for the agent surface (PRD §7.9): the root agent, team members'
 * agents/<member>/agent/ directories, and the dependency manifests — nothing else.
 */
import { describe, expect, it } from "vitest";

import { memberFromPath } from "~/project/agent-context.server";
import { normalizeAgentPath } from "~/project/guard.server";

describe("normalizeAgentPath", () => {
  it("accepts root-agent paths and the manifest allowlist", () => {
    expect(normalizeAgentPath("agent/instructions.md")).toBe("agent/instructions.md");
    expect(normalizeAgentPath("agent/tools/x.ts")).toBe("agent/tools/x.ts");
    expect(normalizeAgentPath("package.json")).toBe("package.json");
    expect(normalizeAgentPath("package-lock.json")).toBe("package-lock.json");
  });

  it("accepts team member paths and their manifests", () => {
    expect(normalizeAgentPath("agents/pm/agent/tools/x.ts")).toBe(
      "agents/pm/agent/tools/x.ts",
    );
    expect(normalizeAgentPath("agents/pm/package.json")).toBe("agents/pm/package.json");
    expect(normalizeAgentPath("agents/pm/package-lock.json")).toBe(
      "agents/pm/package-lock.json",
    );
  });

  it("rejects escapes and everything outside the agent surface", () => {
    expect(normalizeAgentPath("agents/pm/agent/../../../etc/passwd")).toBeNull();
    expect(normalizeAgentPath("agents/pm/secrets.txt")).toBeNull();
    expect(normalizeAgentPath("agents/pm/agent/")).toBeNull();
    expect(normalizeAgentPath("Dockerfile")).toBeNull();
    expect(normalizeAgentPath("src/index.ts")).toBeNull();
    expect(normalizeAgentPath("agents/../package.json")).toBeNull();
  });
});

describe("memberFromPath", () => {
  it("extracts the member from team paths, null otherwise", () => {
    expect(memberFromPath("agents/deployer/agent/tools/x.ts")).toBe("deployer");
    expect(memberFromPath("agent/tools/x.ts")).toBeNull();
    expect(memberFromPath("package.json")).toBeNull();
  });
});
