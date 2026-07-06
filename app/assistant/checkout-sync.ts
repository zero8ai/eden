/**
 * Pure logic for mirroring an assistant conversation's checkout to GitHub (docs/ASSISTANT.md —
 * coding-agent model). The instance-side sidecar reports the checkout's full tree state vs its
 * base branch (`TreeState`); this module turns that into a commit plan for `commitFiles`, applies
 * the server-side path policy, and computes the skip-if-unchanged hash. No I/O — the git/GitHub
 * calls live in `checkout-sync.server.ts`, so the mapping is unit-tested in isolation.
 */
import { createHash } from "node:crypto";

import type { FileChange } from "~/github/write.server";

/** One dirty path in a checkout, relative to the repo root (forward-slashed). */
export type DirtyStatus = "added" | "modified" | "deleted";

export interface DirtyFile {
  path: string;
  status: DirtyStatus;
  /** New UTF-8 content for added/modified text files; absent for deletions, binary, or oversize. */
  content?: string | null;
  /** True when the sidecar skipped the body because the file is binary. */
  binary?: boolean;
  /** True when the sidecar skipped the body because the file exceeds the size cap. */
  oversize?: boolean;
}

/** The instance-reported state of a conversation checkout vs the merge-base with its base branch. */
export interface TreeState {
  branch: string;
  /** merge-base sha the diff is computed against (the base branch tip at checkout time). */
  baseSha: string;
  dirty: DirtyFile[];
}

/**
 * Paths the assistant may edit in its sandbox but that must NEVER be committed to the branch:
 * its own model override (`assistant.json`) and the Eden-owned `.ts` tool/agent layer under
 * `.eden/assistant/`. Review can't undo a merged change to these, so they're stripped pre-commit
 * (and the model is told, so it doesn't think its edit stuck). Everything else is allowed —
 * PR review is the backstop.
 */
export function isBlockedPath(path: string): boolean {
  if (path === ".eden/assistant/assistant.json") return true;
  if (path.startsWith(".eden/assistant/") && path.endsWith(".ts")) return true;
  return false;
}

export interface CommitPlan {
  /** Files to commit (writes + deletions), already path-policy-filtered. */
  files: FileChange[];
  /** Paths dropped by the path policy (surface to the model + PR body). */
  blocked: string[];
  /** Added/modified paths whose body the sidecar skipped (binary/oversize) — not committed. */
  skippedBodies: string[];
  /** Stable hash of the committed set — equal hash across syncs ⇒ nothing to do. */
  hash: string;
}

/**
 * Turn a reported tree state into a GitHub commit plan. Deletions always commit (`content: null`);
 * added/modified commit only when the sidecar sent a text body (binary/oversize are recorded and
 * skipped). Blocked paths are removed regardless of status. The hash covers exactly what will be
 * committed, so a turn that changed nothing committable is a no-op the engine can skip.
 */
export function planCommit(tree: TreeState): CommitPlan {
  const files: FileChange[] = [];
  const blocked: string[] = [];
  const skippedBodies: string[] = [];

  for (const f of tree.dirty) {
    if (isBlockedPath(f.path)) {
      blocked.push(f.path);
      continue;
    }
    if (f.status === "deleted") {
      files.push({ path: f.path, content: null });
      continue;
    }
    if (f.binary || f.oversize || typeof f.content !== "string") {
      skippedBodies.push(f.path);
      continue;
    }
    files.push({ path: f.path, content: f.content });
  }

  // Deterministic order so the hash is stable regardless of the sidecar's listing order.
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const hasher = createHash("sha256");
  hasher.update(tree.baseSha);
  hasher.update("\0");
  for (const f of files) {
    hasher.update(f.path);
    hasher.update("\0");
    hasher.update(f.content === null ? "\x00DELETE\x00" : f.content);
    hasher.update("\0");
  }
  blocked.sort();
  skippedBodies.sort();

  return { files, blocked, skippedBodies, hash: hasher.digest("hex") };
}

/** Human-readable warning block for the PR body / model note when paths were dropped. */
export function policyWarnings(plan: CommitPlan): string[] {
  const warnings: string[] = [];
  if (plan.blocked.length > 0) {
    warnings.push(
      `Excluded from this change (Eden-owned, never committed from a conversation): ${plan.blocked.join(", ")}.`,
    );
  }
  if (plan.skippedBodies.length > 0) {
    warnings.push(
      `Skipped (binary or over the 1MB cap, not mirrored): ${plan.skippedBodies.join(", ")}.`,
    );
  }
  return warnings;
}

/** The working branch a conversation's checkout is mirrored onto. */
export function conversationBranch(conversationId: string): string {
  return `eden/conv-${conversationId}`;
}

/** Absolute path of a conversation's checkout inside the instance/sandbox (shared home volume). */
export function conversationCheckoutPath(conversationId: string): string {
  return `/workspace/home/checkouts/${conversationId}`;
}
