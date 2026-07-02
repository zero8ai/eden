/**
 * Staged change-sets (PRD §7.3) — against the in-memory store, with a fake propose function
 * (no DB, no GitHub). Pins the staging contract: save = upsert per path (refresh-proof),
 * publish = ONE change-set from the SELECTED drafts only (published drafts cleared, unchecked
 * ones kept), and discard is path-exact.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  discardDrafts,
  getDraft,
  listDrafts,
  publishDrafts,
} from "~/drafts/drafts.server";
import { stageDraft } from "~/drafts/drafts.server";
import type { ProposedChange } from "~/github/write.server";
import { makeFakeStore, type FakeStore } from "../fakes/store";

let store: FakeStore;
const PROJECT = {
  id: "proj_1",
  repoInstallationId: "inst_1",
  repoOwner: "acme",
  repoName: "agent",
  defaultBranch: "main",
};

const proposed: ProposedChange = {
  branch: "eden/publish-x",
  base: "main",
  pullRequestUrl: "https://github.test/pr/7",
  pullRequestNumber: 7,
  reusedPullRequest: false,
};

beforeEach(() => {
  store = makeFakeStore();
  store.seedProject({ id: PROJECT.id, orgId: "org_1" });
});

describe("staging", () => {
  it("persists a draft per path and re-save overwrites it (refresh-proof)", async () => {
    await stageDraft({ projectId: PROJECT.id, path: "agent/instructions.md", content: "v1" }, store);
    await stageDraft({ projectId: PROJECT.id, path: "agent/instructions.md", content: "v2" }, store);

    const draft = await getDraft(PROJECT.id, "agent/instructions.md", store);
    expect(draft?.content).toBe("v2");
    expect(await listDrafts(PROJECT.id, store)).toHaveLength(1);
  });

  it("discards path-exactly", async () => {
    await stageDraft({ projectId: PROJECT.id, path: "agent/a.md", content: "a" }, store);
    await stageDraft({ projectId: PROJECT.id, path: "agent/b.md", content: "b" }, store);
    await discardDrafts(PROJECT.id, ["agent/a.md"], store);

    expect(await getDraft(PROJECT.id, "agent/a.md", store)).toBeNull();
    expect((await getDraft(PROJECT.id, "agent/b.md", store))?.content).toBe("b");
  });
});

describe("publishDrafts", () => {
  it("publishes ONLY the selected drafts as one change-set and keeps the rest staged", async () => {
    await stageDraft({ projectId: PROJECT.id, path: "agent/a.md", content: "A" }, store);
    await stageDraft({ projectId: PROJECT.id, path: "agent/b.md", content: "B" }, store);
    await stageDraft({ projectId: PROJECT.id, path: "agent/c.md", content: "C" }, store);

    const propose = vi.fn().mockResolvedValue(proposed);
    const change = await publishDrafts(
      { project: PROJECT, paths: ["agent/a.md", "agent/c.md"] }, // b unchecked
      store,
      propose,
    );
    expect(change.pullRequestNumber).toBe(7);

    // One propose call carrying exactly the selected files.
    expect(propose).toHaveBeenCalledOnce();
    const input = propose.mock.calls[0][2];
    expect(input.files).toEqual([
      { path: "agent/a.md", content: "A" },
      { path: "agent/c.md", content: "C" },
    ]);
    expect(input.base).toBe("main");
    expect(input.title).toBe("Update 2 agent files");

    // Published drafts cleared; the unchecked one survives for a later publish.
    const remaining = await listDrafts(PROJECT.id, store);
    expect(remaining.map((d) => d.path)).toEqual(["agent/b.md"]);
  });

  it("uses the single path as the title for a one-file publish", async () => {
    await stageDraft({ projectId: PROJECT.id, path: "agent/tools/x.ts", content: "X" }, store);
    const propose = vi.fn().mockResolvedValue(proposed);
    await publishDrafts({ project: PROJECT, paths: ["agent/tools/x.ts"] }, store, propose);
    expect(propose.mock.calls[0][2].title).toBe("Update agent/tools/x.ts");
  });

  it("rejects an empty selection", async () => {
    await stageDraft({ projectId: PROJECT.id, path: "agent/a.md", content: "A" }, store);
    await expect(
      publishDrafts({ project: PROJECT, paths: [] }, store, vi.fn()),
    ).rejects.toThrow(/No staged changes selected/);
  });

  it("keeps drafts staged when the propose call fails", async () => {
    await stageDraft({ projectId: PROJECT.id, path: "agent/a.md", content: "A" }, store);
    const propose = vi.fn().mockRejectedValue(new Error("github down"));
    await expect(
      publishDrafts({ project: PROJECT, paths: ["agent/a.md"] }, store, propose),
    ).rejects.toThrow("github down");
    // Nothing was deleted — the human can retry.
    expect(await listDrafts(PROJECT.id, store)).toHaveLength(1);
  });
});
