import { describe, expect, it } from "vitest";

import { memberScaffold, teamFiles } from "~/github/create.server";
import { EMPTY_TEAM_MARKER } from "~/eve/parse";

describe("repo scaffold", () => {
  it("creates an empty team skeleton with a durable marker and no member package", () => {
    const paths = teamFiles("my-team").map((file) => file.path);
    expect(paths).toContain(EMPTY_TEAM_MARKER);
    expect(paths).toContain("package.json");
    expect(paths).toContain("eden.json");
    expect(paths.some((path) => /^agents\/[^/]+\/agent\//.test(path))).toBe(
      false,
    );
    expect(
      paths.some((path) => /^agents\/[^/]+\/package\.json$/.test(path)),
    ).toBe(false);
  });

  it("starts new members without a dummy example tool", () => {
    const files = memberScaffold(
      "assistant",
      "anthropic/abcdefghijkl/claude-sonnet-4-5",
    );

    expect(files.map((file) => file.path)).toEqual([
      "agents/assistant/agent/instructions.md",
      "agents/assistant/agent/agent.ts",
      "agents/assistant/agent/sandbox.ts",
      "agents/assistant/package.json",
    ]);
    expect(files.some((file) => file.path.includes("/tools/"))).toBe(false);
    expect(
      files.find((file) => file.path.endsWith("agent.ts"))?.content,
    ).toContain("edenModel('anthropic/abcdefghijkl/claude-sonnet-4-5')");
    const packageJson = files.find((file) =>
      file.path.endsWith("package.json"),
    );
    expect(packageJson?.content).toBeTypeOf("string");
    expect(JSON.parse(packageJson!.content as string).dependencies).toEqual({
      "@ai-sdk/anthropic": "^4.0.12",
      "@ai-sdk/openai": "^4.0.11",
      "@ai-sdk/openai-compatible": "^3.0.7",
      ai: "^7.0.0",
      zod: "^4.4.3",
      eve: "latest",
    });
  });
});
