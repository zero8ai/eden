import { describe, expect, it } from "vitest";

import { memberScaffold } from "~/github/create.server";

describe("repo scaffold", () => {
  it("starts new members without a dummy example tool", () => {
    const files = memberScaffold("assistant");

    expect(files.map((file) => file.path)).toEqual([
      "agents/assistant/agent/instructions.md",
      "agents/assistant/agent/agent.ts",
      "agents/assistant/agent/sandbox.ts",
      "agents/assistant/package.json",
    ]);
    expect(files.some((file) => file.path.includes("/tools/"))).toBe(false);
    const packageJson = files.find((file) =>
      file.path.endsWith("package.json"),
    );
    expect(packageJson?.content).toBeTypeOf("string");
    expect(
      JSON.parse(packageJson!.content as string).dependencies,
    ).not.toHaveProperty("zod");
  });
});
