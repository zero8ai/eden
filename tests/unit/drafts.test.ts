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
  resolveFileView,
  type FileViewDeps,
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
  // Drafts key by roster member (Milestone 5.5) — a single-agent repo is a team of one.
  store.seedAgent({ id: "agent_1", projectId: PROJECT.id });
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

describe("publish gate (build check)", () => {
  it("a failing check blocks the change request and keeps drafts staged", async () => {
    await stageDraft({ projectId: PROJECT.id, path: "agent/tools/w.ts", content: "bad" }, store);
    const propose = vi.fn().mockResolvedValue(proposed);
    const failCheck = vi
      .fn()
      .mockResolvedValue({ ok: false, output: "'eve' does not provide defineTool" });

    await expect(
      publishDrafts({ project: PROJECT, paths: ["agent/tools/w.ts"] }, store, propose, failCheck),
    ).rejects.toThrow(/Build check failed[\s\S]*does not provide defineTool/);

    expect(propose).not.toHaveBeenCalled(); // no branch, no PR
    expect(await listDrafts(PROJECT.id, store)).toHaveLength(1); // fix & retry
  });

  it("checks exactly the SELECTED drafts against the default branch", async () => {
    await stageDraft({ projectId: PROJECT.id, path: "agent/a.md", content: "A" }, store);
    await stageDraft({ projectId: PROJECT.id, path: "agent/b.md", content: "B" }, store);
    const check = vi.fn().mockResolvedValue({ ok: true });
    await publishDrafts(
      { project: PROJECT, paths: ["agent/a.md"] },
      store,
      vi.fn().mockResolvedValue(proposed),
      check,
    );
    expect(check).toHaveBeenCalledWith({
      projectId: PROJECT.id,
      repo: { owner: "acme", repo: "agent" },
      ref: "main",
      installationId: "inst_1",
      overlay: [{ path: "agent/a.md", content: "A" }],
      // All selected drafts belong to the sole roster member, so the gate targets its root.
      agentRoot: "agent",
    });
  });

  it("a skipped check (no toolchain) still publishes", async () => {
    await stageDraft({ projectId: PROJECT.id, path: "agent/a.md", content: "A" }, store);
    const propose = vi.fn().mockResolvedValue(proposed);
    const change = await publishDrafts(
      { project: PROJECT, paths: ["agent/a.md"] },
      store,
      propose,
      vi.fn().mockResolvedValue({ ok: true, skipped: true }),
    );
    expect(change.pullRequestNumber).toBe(7);
  });
});

describe("resolveFileView", () => {
  const PATH = "agent/agent.ts";
  /** GitHub fakes: repo (default branch) content + one open change touching PATH. */
  function deps({
    repoContent = "repo",
    pendingContent = "pending",
    pending = true,
  }: {
    repoContent?: string | null;
    pendingContent?: string | null;
    pending?: boolean;
  } = {}): FileViewDeps {
    return {
      readFile: vi.fn(async (_inst, repo: { ref?: string }) =>
        repo.ref === "eden/publish-x" ? pendingContent : repoContent,
      ) as FileViewDeps["readFile"],
      findOpenChange: vi.fn(async () =>
        pending
          ? { number: 7, title: "Update agent files", branch: "eden/publish-x", url: "u" }
          : null,
      ) as FileViewDeps["findOpenChange"],
    };
  }

  it("a staged draft wins over everything (it's the newest edit)", async () => {
    await stageDraft({ projectId: PROJECT.id, path: PATH, content: "draft" }, store);
    const view = await resolveFileView(PROJECT, PATH, store, deps());
    expect(view).toMatchObject({ content: "draft", source: "draft", existsInRepo: true });
  });

  it("with no draft, shows the pending value from the open change request", async () => {
    const view = await resolveFileView(PROJECT, PATH, store, deps());
    expect(view).toMatchObject({
      content: "pending",
      source: "change-request",
      change: { number: 7, title: "Update agent files" },
    });
  });

  it("falls back to repo content when nothing is staged or pending", async () => {
    const view = await resolveFileView(PROJECT, PATH, store, deps({ pending: false }));
    expect(view).toMatchObject({ content: "repo", source: "repo", change: null });
  });

  it("a change request that ADDS the file still resolves (repo has nothing)", async () => {
    const view = await resolveFileView(
      PROJECT,
      PATH,
      store,
      deps({ repoContent: null }),
    );
    expect(view).toMatchObject({
      content: "pending",
      source: "change-request",
      existsInRepo: false,
    });
  });

});
