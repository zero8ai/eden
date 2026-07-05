/**
 * The ONE conversation per (project, surface/scope, user) — deliberately no session
 * management. It survives navigation (persisted, PRD-style "it should still be there when
 * I come back") and goes stale instead of accumulating: after IDLE_EXPIRY without a
 * message, the next visit starts fresh (the row is simply overwritten on the next save).
 * "New conversation" deletes it explicitly.
 */
import type { ChatEntry } from "~/chat/types";
import type { DataStore } from "~/data/ports";
import { getRuntime } from "~/seams/index.server";

export type ConversationKind =
  "assistant" | "playground" | `playground:${string}`;

/** Idle time after which a conversation no longer resumes (fresh start on next visit). */
export const IDLE_EXPIRY_MS = 24 * 60 * 60 * 1000;

export interface LoadedConversation<S> {
  entries: ChatEntry[];
  state: S;
  /** True when a previous conversation existed but aged out (surface a gentle note). */
  expired: boolean;
}

export function isExpired(updatedAt: Date, now: Date = new Date()): boolean {
  return now.getTime() - updatedAt.getTime() > IDLE_EXPIRY_MS;
}

export async function loadConversation<S extends Record<string, unknown>>(
  projectId: string,
  kind: ConversationKind,
  userId: string,
  emptyState: S,
  store: DataStore = getRuntime().data,
): Promise<LoadedConversation<S>> {
  const row = await store.conversations.get(projectId, kind, userId);
  if (!row) return { entries: [], state: emptyState, expired: false };
  if (isExpired(row.updatedAt)) return { entries: [], state: emptyState, expired: true };
  return {
    entries: row.messages as ChatEntry[],
    state: { ...emptyState, ...(row.state as S) },
    expired: false,
  };
}

export async function saveConversation<S extends Record<string, unknown>>(
  projectId: string,
  kind: ConversationKind,
  userId: string,
  entries: ChatEntry[],
  state: S,
  store: DataStore = getRuntime().data,
): Promise<void> {
  await store.conversations.save({
    projectId,
    kind,
    createdBy: userId,
    messages: entries,
    state,
  });
}

export function resetConversation(
  projectId: string,
  kind: ConversationKind,
  userId: string,
  store: DataStore = getRuntime().data,
): Promise<void> {
  return store.conversations.delete(projectId, kind, userId);
}
