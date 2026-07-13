/**
 * Workspace task projection (issue #142) — thin helpers over WorkspaceTaskRepo.
 *
 * A "workspace task" is the small, project-scoped, user-facing record behind the persistent
 * task-progress indicator at the top of a workspace. The durable `jobs` queue is still the ops
 * primitive that RUNS the work (retry/claim/backoff); a runner streams its human-readable stage
 * into a task row here and resolves it to a terminal state. The indicator polls these rows.
 *
 * Every function takes `store: DataStore = getRuntime().data` so runners and route actions inject a
 * fake in unit tests, mirroring drafts.server.ts.
 */
import type { DataStore, WorkspaceTask } from "~/data/ports";
import { getRuntime } from "~/seams/index.server";

/** How long a terminal (succeeded|failed) task lingers in the indicator before it ages out. */
const TERMINAL_WINDOW_MS = 24 * 60 * 60 * 1000;

export function createTask(
  input: {
    projectId: string;
    kind: string;
    subjectKey: string;
    label: string;
    originUrl: string;
    stage?: string | null;
    jobId?: string | null;
    createdBy?: string | null;
  },
  store: DataStore = getRuntime().data,
): Promise<WorkspaceTask> {
  return store.workspaceTasks.insert(input);
}

/** Attach the queue job that will run this task (create → enqueue → link). */
export async function setTaskJob(
  id: string,
  jobId: string,
  store: DataStore = getRuntime().data,
): Promise<void> {
  await store.workspaceTasks.update(id, { jobId });
}

/** Stream the current step into the indicator. */
export async function updateTaskStage(
  id: string,
  stage: string,
  store: DataStore = getRuntime().data,
): Promise<void> {
  await store.workspaceTasks.update(id, { stage });
}

/** Resolve a task as succeeded, clearing the stage and recording where the result lives. */
export async function completeTask(
  id: string,
  opts: { resultUrl?: string | null },
  store: DataStore = getRuntime().data,
): Promise<void> {
  await store.workspaceTasks.update(id, {
    status: "succeeded",
    stage: null,
    resultUrl: opts.resultUrl ?? null,
    error: null,
  });
}

/** Resolve a task as failed, clearing the stage and recording the error for the indicator. */
export async function failTask(
  id: string,
  error: string,
  store: DataStore = getRuntime().data,
): Promise<void> {
  await store.workspaceTasks.update(id, { status: "failed", stage: null, error });
}

/** The indicator's read set for a project: running + recent terminal tasks, oldest-first. */
export function listWorkspaceTasks(
  projectId: string,
  store: DataStore = getRuntime().data,
): Promise<WorkspaceTask[]> {
  return store.workspaceTasks.listActive(projectId, new Date(Date.now() - TERMINAL_WINDOW_MS));
}

/** The running task for a trigger surface, or null — used to dedupe re-triggers. */
export function findRunningTask(
  projectId: string,
  subjectKey: string,
  store: DataStore = getRuntime().data,
): Promise<WorkspaceTask | null> {
  return store.workspaceTasks.findRunningBySubject(projectId, subjectKey);
}

/**
 * Dismiss a terminal task (the × in the indicator). A running task can't be dismissed — the UI
 * only offers dismiss on terminal rows, and this refuses one defensively (returns false).
 */
export async function dismissTask(
  id: string,
  store: DataStore = getRuntime().data,
): Promise<boolean> {
  const task = await store.workspaceTasks.findById(id);
  if (!task || task.status === "running") return false;
  await store.workspaceTasks.update(id, { dismissedAt: new Date() });
  return true;
}
