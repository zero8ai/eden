/**
 * Quick deploy scope logic (PRD §7.3/§7.7) — the branching the tab-row button's resource route
 * defers to, exercised as pure functions (no auth/DB/GitHub). Pins the two decisions that differ
 * by hierarchy level: which environments the button offers (a member's own vs. the roster union),
 * and which drafts count as "staged for this scope" (own + shared vs. all).
 */
import { describe, expect, it } from "vitest";

import { draftsInScope, unionEnvNames } from "~/deploy/quick-deploy";
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

describe("unionEnvNames", () => {
  it("de-duplicates across the roster, keeping first-seen order (primary tends to lead)", () => {
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

  it("is empty for an empty roster", () => {
    expect(unionEnvNames([])).toEqual([]);
    expect(unionEnvNames([[], []])).toEqual([]);
  });
});

describe("draftsInScope", () => {
  const drafts = [draft("agent_a"), draft("agent_b"), draft(null)];

  it("member scope keeps the member's own drafts plus shared (unattributed) ones", () => {
    expect(draftsInScope(drafts, "agent_a").map((d) => d.agentId)).toEqual([
      "agent_a",
      null,
    ]);
  });

  it("repo scope (null active) keeps every draft", () => {
    expect(draftsInScope(drafts, null)).toHaveLength(3);
  });
});
