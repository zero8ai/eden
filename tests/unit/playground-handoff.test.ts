import { describe, expect, it } from "vitest";

import {
  cacheCoversCompletedLiveTurn,
  liveTurnIsForDifferentSession,
} from "~/playground/handoff";

describe("playground live-turn handoff", () => {
  it("detects a live turn from a different selected session", () => {
    expect(liveTurnIsForDifferentSession("session-a", "session-b")).toBe(true);
    expect(liveTurnIsForDifferentSession("session-a", "session-a")).toBe(false);
  });

  it("keeps first-turn handoff compatible while the loader session id is null", () => {
    expect(liveTurnIsForDifferentSession("new-session", null)).toBe(false);
  });

  it("does not hand off to a cached user-only prefix", () => {
    expect(
      cacheCoversCompletedLiveTurn({
        liveSessionId: "session-a",
        currentSessionId: "session-a",
        currentSessionStatus: "waiting",
        liveDone: true,
        baseEntryCount: 2,
        entries: [{ role: "user" }, { role: "assistant" }, { role: "user" }],
      }),
    ).toBe(false);
  });

  it("waits for the persisted session status to settle", () => {
    expect(
      cacheCoversCompletedLiveTurn({
        liveSessionId: "session-a",
        currentSessionId: "session-a",
        currentSessionStatus: "running",
        liveDone: true,
        baseEntryCount: 0,
        entries: [{ role: "assistant" }],
      }),
    ).toBe(false);
  });

  it("hands off once the current settled session has a cached assistant entry", () => {
    expect(
      cacheCoversCompletedLiveTurn({
        liveSessionId: "session-a",
        currentSessionId: "session-a",
        currentSessionStatus: "failed",
        liveDone: true,
        baseEntryCount: 1,
        entries: [{ role: "user" }, { role: "assistant" }],
      }),
    ).toBe(true);
  });

  it("never treats another session's cache as coverage", () => {
    expect(
      cacheCoversCompletedLiveTurn({
        liveSessionId: "session-a",
        currentSessionId: "session-b",
        currentSessionStatus: "waiting",
        liveDone: true,
        baseEntryCount: 0,
        entries: [{ role: "assistant" }],
      }),
    ).toBe(false);
  });
});
