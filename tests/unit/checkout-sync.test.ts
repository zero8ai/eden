import { describe, expect, it } from "vitest";

import {
  conversationBranch,
  conversationCheckoutPath,
  isBlockedPath,
  planCommit,
  policyWarnings,
  type TreeState,
} from "~/assistant/checkout-sync";
import { narrowedReadTokenParams } from "~/github/client.server";
// The instance-side sidecar's pure record classifier (importing the module must not bind a port).
import { classifyRawRecord } from "../../assistant-template/checkout-sidecar.mjs";

const tree = (dirty: TreeState["dirty"], baseSha = "base0"): TreeState => ({
  branch: "eden/conv-abc",
  baseSha,
  dirty,
});

describe("checkout-sync: path policy", () => {
  it("blocks assistant.json and .ts under .eden/assistant, allows everything else", () => {
    expect(isBlockedPath(".eden/assistant/assistant.json")).toBe(true);
    expect(isBlockedPath(".eden/assistant/tools/foo.ts")).toBe(true);
    expect(isBlockedPath(".eden/assistant/instructions.md")).toBe(false);
    expect(isBlockedPath(".eden/assistant/skills/x.md")).toBe(false);
    expect(isBlockedPath("agent/tools/foo.ts")).toBe(false);
    expect(isBlockedPath("package.json")).toBe(false);
  });

  it("strips blocked paths from the commit and records them as warnings", () => {
    const plan = planCommit(
      tree([
        { path: "agent/tools/foo.ts", status: "added", content: "export default 1;" },
        { path: ".eden/assistant/assistant.json", status: "modified", content: "{}" },
        { path: ".eden/assistant/agent.ts", status: "added", content: "x" },
      ]),
    );
    expect(plan.files.map((f) => f.path)).toEqual(["agent/tools/foo.ts"]);
    expect(plan.blocked).toEqual([".eden/assistant/agent.ts", ".eden/assistant/assistant.json"]);
    expect(policyWarnings(plan)[0]).toContain(".eden/assistant/agent.ts");
  });
});

describe("checkout-sync: diff → commit mapping", () => {
  it("maps added/modified to writes and deleted to null-content deletions", () => {
    const plan = planCommit(
      tree([
        { path: "a.ts", status: "added", content: "A" },
        { path: "b.ts", status: "modified", content: "B" },
        { path: "c.ts", status: "deleted" },
      ]),
    );
    expect(plan.files).toEqual([
      { path: "a.ts", content: "A" },
      { path: "b.ts", content: "B" },
      { path: "c.ts", content: null },
    ]);
  });

  it("skips binary and oversize bodies but keeps them as warnings", () => {
    const plan = planCommit(
      tree([
        { path: "img.png", status: "added", binary: true },
        { path: "big.bin", status: "modified", oversize: true },
        { path: "ok.ts", status: "added", content: "ok" },
      ]),
    );
    expect(plan.files.map((f) => f.path)).toEqual(["ok.ts"]);
    expect(plan.skippedBodies).toEqual(["big.bin", "img.png"]);
    expect(policyWarnings(plan).some((w) => w.includes("1MB"))).toBe(true);
  });

  it("never commits non-regular files (symlinks/submodules), even with a smuggled body", () => {
    // A model-authored symlink could point at instance files (e.g. /proc/1/environ). The sidecar
    // flags it notFile and sends no body — and even if a body somehow arrived, the flag wins.
    const plan = planCommit(
      tree([
        { path: "leak.txt", status: "added", notFile: true, content: "SECRET=oops" },
        { path: "vendor", status: "added", notFile: true },
        { path: "ok.ts", status: "added", content: "ok" },
      ]),
    );
    expect(plan.files.map((f) => f.path)).toEqual(["ok.ts"]);
    expect(plan.notFiles).toEqual(["leak.txt", "vendor"]);
    expect(policyWarnings(plan).some((w) => w.includes("symlink"))).toBe(true);
  });

  it("carries the executable bit into the plan and the hash", () => {
    const plain = planCommit(tree([{ path: "run.sh", status: "added", content: "#!/bin/sh" }]));
    const exec = planCommit(
      tree([{ path: "run.sh", status: "added", content: "#!/bin/sh", executable: true }]),
    );
    expect(plain.files[0].executable).toBeUndefined();
    expect(exec.files[0].executable).toBe(true);
    // A bare chmod +x (same content) must still register as a change to sync.
    expect(exec.hash).not.toBe(plain.hash);
  });

  it("hashes deterministically regardless of input order, and changes with content", () => {
    const a = planCommit(
      tree([
        { path: "a.ts", status: "added", content: "A" },
        { path: "b.ts", status: "added", content: "B" },
      ]),
    );
    const b = planCommit(
      tree([
        { path: "b.ts", status: "added", content: "B" },
        { path: "a.ts", status: "added", content: "A" },
      ]),
    );
    expect(a.hash).toBe(b.hash);

    const changed = planCommit(
      tree([
        { path: "a.ts", status: "added", content: "A2" },
        { path: "b.ts", status: "added", content: "B" },
      ]),
    );
    expect(changed.hash).not.toBe(a.hash);

    // A different base with the same files is a different snapshot.
    const rebased = planCommit(
      tree(
        [
          { path: "a.ts", status: "added", content: "A" },
          { path: "b.ts", status: "added", content: "B" },
        ],
        "base1",
      ),
    );
    expect(rebased.hash).not.toBe(a.hash);
  });

  it("an empty dirty set produces no files (a no-op sync)", () => {
    const plan = planCommit(tree([]));
    expect(plan.files).toEqual([]);
    expect(policyWarnings(plan)).toEqual([]);
  });
});

describe("checkout-sync: naming", () => {
  it("derives branch and checkout path from the conversation id", () => {
    expect(conversationBranch("abc")).toBe("eden/conv-abc");
    expect(conversationCheckoutPath("abc")).toBe("/workspace/home/checkouts/abc");
  });
});

describe("checkout sidecar: raw-diff record classification", () => {
  const meta = (newMode: string, status: string) =>
    `:100644 ${newMode} 0000000 1111111 ${status}`;

  it("classifies regular files, executables, deletions", () => {
    expect(classifyRawRecord(meta("100644", "A"), "a.ts")).toEqual({ path: "a.ts", status: "added" });
    expect(classifyRawRecord(meta("100644", "M"), "b.ts")).toEqual({ path: "b.ts", status: "modified" });
    expect(classifyRawRecord(meta("100755", "A"), "run.sh")).toEqual({
      path: "run.sh",
      status: "added",
      executable: true,
    });
    expect(classifyRawRecord(":100644 000000 1111111 0000000 D", "gone.ts")).toEqual({
      path: "gone.ts",
      status: "deleted",
    });
  });

  it("flags symlinks and submodules notFile so their bodies are never read", () => {
    expect(classifyRawRecord(meta("120000", "A"), "leak")).toEqual({
      path: "leak",
      status: "added",
      notFile: true,
    });
    expect(classifyRawRecord(meta("160000", "M"), "sub")).toEqual({
      path: "sub",
      status: "modified",
      notFile: true,
    });
  });

  it("ignores non-record lines", () => {
    expect(classifyRawRecord("garbage", "x")).toBeNull();
  });
});

describe("github: narrowed read token request shape", () => {
  it("scopes to exactly one repo with contents:read only", () => {
    const params = narrowedReadTokenParams("123", "my-repo");
    expect(params).toEqual({
      installation_id: 123,
      repositories: ["my-repo"],
      permissions: { contents: "read" },
    });
    // Guard against accidental permission widening.
    expect(Object.keys(params.permissions)).toEqual(["contents"]);
  });
});
