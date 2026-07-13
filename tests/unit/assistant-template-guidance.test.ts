import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const readTemplate = (path: string) =>
  readFile(
    new URL(`../../assistant-template/${path}`, import.meta.url),
    "utf8",
  );

describe("assistant template authoring guidance", () => {
  it("requires control-plane and checkout grounding before proposals", async () => {
    const [instructions, contextTool] = await Promise.all([
      readTemplate("agent/instructions.md"),
      readTemplate("agent/tools/eden-project-context.ts"),
    ]);

    expect(instructions).toMatch(
      /before proposing anything[\s\S]*eden_project_context[\s\S]*(bash|checkout)/i,
    );
    expect(instructions).toMatch(/plan, suggestion, or change/i);
    expect(instructions).toMatch(
      /pwd[\s\S]*git status[\s\S]*(tree|repository tree)/i,
    );
    expect(contextTool).toMatch(
      /required before proposing[\s\S]*plan, suggestion, or change/i,
    );
    expect(contextTool).toMatch(/actual git checkout/i);
  });

  it("ships an executable plan-to-behavioral-validation workflow", async () => {
    const skill = await readTemplate("agent/skills/plan-implement-validate.md");

    expect(skill).toMatch(
      /^---[\s\S]*description:.*create, build, change, or fix.*eve agent/im,
    );
    expect(skill).toMatch(
      /plan is a working checklist[\s\S]*(execute|executed)/i,
    );
    expect(skill).toMatch(/evals\//);
    expect(skill).toMatch(/multiple `t\.send/);
    expect(skill).toContain("t.loadedSkill");
    expect(skill).toMatch(/GET `?\/eve\/v1\/info/i);
    expect(skill).toMatch(/POST `?\/eve\/v1\/dev\/schedules\/<id>/i);
    expect(skill).toContain("npx eve eval --url <url>");
  });

  it("does not refer to removed draft-era authoring tools", async () => {
    const guidance = await Promise.all([
      readTemplate("agent/instructions.md"),
      readTemplate("agent/skills/building-eve-agents.md"),
      readTemplate("agent/skills/plan-implement-validate.md"),
      readTemplate("agent/tools/eden-project-context.ts"),
    ]).then((files) => files.join("\n"));

    expect(guidance).not.toContain("eden_add_dependency");
    expect(guidance).not.toContain("eden_run_checks");
    expect(guidance).not.toMatch(/staged drafts?/i);
  });

  it("passes the normalized assistant effort into the eve agent runtime", async () => {
    const [agent, bootstrap, entrypoint] = await Promise.all([
      readTemplate("agent/agent.ts"),
      readTemplate("bootstrap.mjs"),
      readTemplate("entrypoint.sh"),
    ]);

    expect(agent).toMatch(/reasoning:\s*assistantEffort/);
    expect(agent).toContain("EDEN_ASSISTANT_EFFORT");
    expect(bootstrap).toContain('shellAssignment("EDEN_ASSISTANT_EFFORT"');
    expect(entrypoint).toContain("export EDEN_ASSISTANT_EFFORT");
  });
});
