/**
 * Quick deploy logic (PRD §7.3/§7.7) — the pure branching the tab-row button's confirmation
 * dialog defers to, exercised without auth/DB/GitHub. Pins the file breakdown grouped by owner
 * (+ shared). "Who deploys" is no longer computed here: the team is the deployment unit, so a
 * ship always moves the whole roster — the dialog just lists the roster the route hands it.
 */
import { describe, expect, it } from "vitest";

import { groupDrafts, shouldCloseAfterShip } from "~/deploy/quick-deploy";
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

/**
 * The dialog cannot rely on unmounting to dismiss (AgentNav lives in the layout the post-ship
 * redirect lands back on), so it closes itself on the in-flight → idle transition — but ONLY when
 * the action redirected (no { error } payload). Pins that transition table.
 */
describe("shouldCloseAfterShip", () => {
  it("closes when a ship finishes without an error (action redirected)", () => {
    expect(
      shouldCloseAfterShip({ wasDeploying: true, deploying: false, error: undefined }),
    ).toBe(true);
  });

  it("stays open while the ship is still in flight", () => {
    expect(
      shouldCloseAfterShip({ wasDeploying: false, deploying: true, error: undefined }),
    ).toBe(false);
    expect(
      shouldCloseAfterShip({ wasDeploying: true, deploying: true, error: undefined }),
    ).toBe(false);
  });

  it("stays open when the ship returned an error, so the user can retry or cancel", () => {
    expect(
      shouldCloseAfterShip({ wasDeploying: true, deploying: false, error: "Build gate failed" }),
    ).toBe(false);
  });

  it("does not close idle renders that never shipped (e.g. reopening after an old error)", () => {
    expect(
      shouldCloseAfterShip({ wasDeploying: false, deploying: false, error: undefined }),
    ).toBe(false);
    expect(
      shouldCloseAfterShip({ wasDeploying: false, deploying: false, error: "old error" }),
    ).toBe(false);
  });
});
