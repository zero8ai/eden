/**
 * Staged change-sets (PRD §7.3): saving an editor STAGES a draft (Postgres, refresh-proof);
 * PUBLISHING turns the selected drafts into one working branch + one PR via proposeChange.
 * The product analogue of git's staging area — per-file rows so a change can be unchecked at
 * publish time, which a working-branch-of-commits couldn't do without history rewriting.
 *
 * Drafts are in-flight edits only; the repo remains the source of truth for published config.
 */
import type { DataStore, DraftChange } from "~/data/ports";
import { readAgentFile } from "~/github/repo.server";
import {
  findOpenChangeForFile,
  proposeChange,
  type ProposedChange,
} from "~/github/write.server";
import { newId } from "~/lib/id";
import { getRuntime } from "~/seams/index.server";

export interface StageInput {
  projectId: string;
  path: string;
  content: string;
  /** Blob sha of the file when the edit was made (conflict hints later). */
  baseSha?: string | null;
  createdBy?: string | null;
}

/** Stage (or restage) a draft for a file. Latest save per path wins. */
export function stageDraft(
  input: StageInput,
  store: DataStore = getRuntime().data,
): Promise<DraftChange> {
  return store.drafts.upsert(input);
}

/** All staged drafts for a project, oldest first. */
export function listDrafts(
  projectId: string,
  store: DataStore = getRuntime().data,
): Promise<DraftChange[]> {
  return store.drafts.listByProject(projectId);
}

/** The staged draft for one file, if any (editors overlay this over the repo content). */
export function getDraft(
  projectId: string,
  path: string,
  store: DataStore = getRuntime().data,
): Promise<DraftChange | null> {
  return store.drafts.get(projectId, path);
}

/** Discard staged drafts without publishing. */
export function discardDrafts(
  projectId: string,
  paths: string[],
  store: DataStore = getRuntime().data,
): Promise<void> {
  return store.drafts.deleteByPaths(projectId, paths);
}

/**
 * What an editor should show for a file, and where that value comes from. The editor always
 * displays the user's LATEST intended value, walking back through the change lifecycle:
 *   staged draft → open change request → default branch.
 * Without the middle step, publishing made an edit invisible in the editors (the draft is
 * deleted, main still has the old value) until the change request merged — "I set the model
 * yesterday, why does the editor show the old one?".
 */
export interface FileView {
  /** Content to show; null when the file exists nowhere yet. */
  content: string | null;
  source: "draft" | "change-request" | "repo";
  /** The file exists on the default branch (vs. being newly created by a draft/change). */
  existsInRepo: boolean;
  /** Set when source is "change-request": the open change holding the pending value. */
  change: { number: number; title: string } | null;
}

/** GitHub reads injected so unit tests run without a repo. */
export interface FileViewDeps {
  readFile: typeof readAgentFile;
  findOpenChange: typeof findOpenChangeForFile;
}

export async function resolveFileView(
  project: {
    id: string;
    repoInstallationId: string;
    repoOwner: string;
    repoName: string;
  },
  path: string,
  store: DataStore = getRuntime().data,
  deps: FileViewDeps = { readFile: readAgentFile, findOpenChange: findOpenChangeForFile },
): Promise<FileView> {
  const repo = { owner: project.repoOwner, repo: project.repoName };
  const [repoContent, draft, pending] = await Promise.all([
    deps.readFile(project.repoInstallationId, repo, path),
    store.drafts.get(project.id, path),
    deps.findOpenChange(project.repoInstallationId, repo, path),
  ]);
  const existsInRepo = repoContent !== null;

  // A staged draft is the newest edit — it wins even over an open change request.
  if (draft) return { content: draft.content, source: "draft", existsInRepo, change: null };

  if (pending) {
    const pendingContent = await deps.readFile(
      project.repoInstallationId,
      { ...repo, ref: pending.branch },
      path,
    );
    return {
      content: pendingContent ?? repoContent,
      source: "change-request",
      existsInRepo,
      change: { number: pending.number, title: pending.title },
    };
  }

  return { content: repoContent, source: "repo", existsInRepo, change: null };
}

/** Injected so unit tests exercise selection/cleanup without GitHub. */
export type ProposeFn = typeof proposeChange;

/**
 * Publish the SELECTED staged drafts as one change-set: one branch, one commit per file, one
 * PR. Published drafts are deleted (they're now on the branch); unselected drafts stay staged
 * for a later publish. Paths not actually staged are ignored.
 */
export async function publishDrafts(
  input: {
    project: {
      id: string;
      repoInstallationId: string;
      repoOwner: string;
      repoName: string;
      defaultBranch: string;
    };
    /** Paths the human left checked in the staging list. */
    paths: string[];
    title?: string;
    createdBy?: string | null;
  },
  store: DataStore = getRuntime().data,
  propose: ProposeFn = proposeChange,
): Promise<ProposedChange> {
  const staged = await store.drafts.listByProject(input.project.id);
  const selected = staged.filter((d) => input.paths.includes(d.path));
  if (selected.length === 0) {
    throw new Error("No staged changes selected to publish.");
  }

  const title =
    input.title?.trim() ||
    (selected.length === 1
      ? `Update ${selected[0].path}`
      : `Update ${selected.length} agent files`);
  const body = [
    "Published from Eden's staged changes:",
    ...selected.map((d) => `- \`${d.path}\``),
  ].join("\n");

  const change = await propose(
    input.project.repoInstallationId,
    { owner: input.project.repoOwner, repo: input.project.repoName },
    {
      base: input.project.defaultBranch,
      branch: `eden/publish-${newId()}`,
      files: selected.map((d) => ({ path: d.path, content: d.content })),
      title,
      body,
      commitMessage: title,
    },
  );

  // Only after the PR exists: the published drafts now live on the branch.
  await store.drafts.deleteByPaths(
    input.project.id,
    selected.map((d) => d.path),
  );
  return change;
}
