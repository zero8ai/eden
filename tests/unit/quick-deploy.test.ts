/**
 * Quick deploy logic (PRD §7.3/§7.7) — the pure branching the tab-row button's confirmation
 * dialog defers to, exercised without auth/DB/GitHub. Pins the transparency the dialog promises:
 * the file breakdown grouped by owner (+ shared), the expanded "who deploys" set (shared → whole
 * roster), and the environment union offered over the affected members only.
 */
import { describe, expect, it } from "vitest";

import { affectedMembers, groupDrafts, unionEnvNames } from "~/deploy/quick-deploy";
import type { DraftChange } from "~/data/ports";

function draft(agentId: string | null, path = `${agentId ?? "shared"}.ts`): DraftChange {
  return {
    id: `d_${path}`,
    projectId: "proj_1",
    agentId,
    path,
    content: "x",
    baseSha: null,
    createdBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as DraftChange;
}

const roster = [
  { id: "agent_a", name: "alpha" },
  { id: "agent_b", name: "bravo" },
  { id: "agent_c", name: "charlie" },
];

describe("unionEnvNames", () => {
  it("de-duplicates across members, keeping first-seen order (primary tends to lead)", () => {
    expect(
      unionEnvNames([
        ["production", "preview"],
        ["production", "staging"],
      ]),
    ).toEqual(["production", "preview", "staging"]);
  });

  it("preserves each member's creation order and never reorders on a later member", () => {
    expect(
      unionEnvNames([
        ["prod"],
        ["dev", "prod", "qa"],
      ]),
    ).toEqual(["prod", "dev", "qa"]);
  });

  it("is empty for no members", () => {
    expect(unionEnvNames([])).toEqual([]);
    expect(unionEnvNames([[], []])).toEqual([]);
  });
});

describe("groupDrafts", () => {
  it("groups drafts under their owning member (roster order), shared block last", () => {
    const drafts = [
      draft("agent_b", "bravo/instructions.md"),
      draft("agent_a", "alpha/model.md"),
      draft(null, "package.json"),
      draft("agent_a", "alpha/tools.md"),
    ];
    expect(groupDrafts(drafts, roster)).toEqual([
      { member: "alpha", files: ["alpha/model.md", "alpha/tools.md"] },
      { member: "bravo", files: ["bravo/instructions.md"] },
      { member: null, files: ["package.json"] },
    ]);
  });

  it("omits members with no drafts and emits no shared block when nothing is shared", () => {
    expect(groupDrafts([draft("agent_c", "charlie/x.md")], roster)).toEqual([
      { member: "charlie", files: ["charlie/x.md"] },
    ]);
  });

  it("is empty for no drafts", () => {
    expect(groupDrafts([], roster)).toEqual([]);
  });
});

describe("affectedMembers", () => {
  it("is only the members that own drafts (roster order preserved)", () => {
    const affected = affectedMembers([draft("agent_c"), draft("agent_a")], roster);
    expect(affected.map((m) => m.name)).toEqual(["alpha", "charlie"]);
  });

  it("expands to the whole roster when any shared draft is present", () => {
    const affected = affectedMembers([draft("agent_a"), draft(null)], roster);
    expect(affected.map((m) => m.name)).toEqual(["alpha", "bravo", "charlie"]);
  });

  it("is empty when no draft is attributed to a roster member", () => {
    expect(affectedMembers([draft("agent_gone")], roster)).toEqual([]);
  });
});
