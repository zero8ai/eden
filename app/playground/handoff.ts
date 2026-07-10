interface EntryWithRole {
  role: "user" | "assistant";
}

interface VisibleLiveTurn {
  done: boolean;
}

/**
 * Poll while a remote turn is running unless this page is already receiving its
 * active live stream. A missing visible turn also covers a URL/session mismatch.
 */
export function shouldPollRemoteSession(
  remoteBusy: boolean,
  visibleLive: VisibleLiveTurn | null,
): boolean {
  return remoteBusy && (visibleLive === null || visibleLive.done);
}

/** A known live turn from one session must never render under another selected session. */
export function liveTurnIsForDifferentSession(
  liveSessionId: string | null,
  currentSessionId: string | null,
): boolean {
  return (
    liveSessionId !== null &&
    currentSessionId !== null &&
    liveSessionId !== currentSessionId
  );
}

/**
 * Whether the durable loader transcript safely replaces a completed browser-side turn.
 * A cached user row alone is only a prefix; wait for the assistant side and a settled DB status.
 */
export function cacheCoversCompletedLiveTurn(input: {
  liveSessionId: string | null;
  currentSessionId: string | null;
  currentSessionStatus: string | null;
  liveDone: boolean;
  baseEntryCount: number;
  entries: readonly EntryWithRole[];
}): boolean {
  if (!input.liveDone || input.currentSessionStatus === "running") return false;
  if (
    liveTurnIsForDifferentSession(input.liveSessionId, input.currentSessionId)
  ) {
    return false;
  }
  return input.entries
    .slice(input.baseEntryCount)
    .some((entry) => entry.role === "assistant");
}
