/**
 * FOH read cursors (D3/D13). Marking a session read advances the viewer's cursor to the
 * session's `lastEventAt` (the unread signal) and auto-resolves their `finished` inbox items —
 * opening the conversation IS the acknowledgement. Idempotent: the cursor upsert is
 * only-advance in the repo, and resolving an already-resolved item is a no-op.
 */
import type { DataStore } from "~/data/ports";
import { resolveFinishedOnRead } from "~/foh/inbox.server";
import type { PlaygroundSession } from "~/playground/sessions.server";
import { getRuntime } from "~/seams/index.server";

export async function markSessionRead(
  session: Pick<PlaygroundSession, "id" | "lastEventAt">,
  userId: string,
  store: DataStore = getRuntime().data,
): Promise<void> {
  if (session.lastEventAt) {
    await store.conversationReads.upsert(session.id, userId, session.lastEventAt);
  }
  await resolveFinishedOnRead(session.id, userId, store);
}
