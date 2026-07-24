/**
 * Live-turn staleness guard (issue #221 finding 6): the FOH session page's send() closure
 * keeps reading its NDJSON stream after the user navigates to another session — cancelling
 * the browser fetch must not stop the agent turn, so the reader can outlive the view it was
 * started for. Every state update it makes goes through guardStaleLiveUpdate, keyed to the
 * session the reader was started for; these tests prove stale updates are discarded (by
 * identity, so React bails out) and current ones apply.
 */
import { describe, expect, it } from "vitest";

import { guardStaleLiveUpdate } from "~/playground/handoff";

/** Minimal shape of the component's LiveTurn for reducer-style updates. */
interface FakeLive {
  playgroundSessionId: string;
  text: string;
  done: boolean;
}

const liveFor = (sessionId: string, text = ""): FakeLive => ({
  playgroundSessionId: sessionId,
  text,
  done: false,
});

describe("guardStaleLiveUpdate", () => {
  it("applies the update while the reader's session is still on screen", () => {
    const prev = liveFor("ps_a");
    const next = guardStaleLiveUpdate("ps_a", "ps_a", prev, (p) => ({
      ...(p as FakeLive),
      text: "hello",
    }));
    expect((next as FakeLive).text).toBe("hello");
  });

  it("discards a stale reader's update by identity after navigating away", () => {
    // Session B's live state must survive session A's still-running reader untouched —
    // identity equality also lets React skip the re-render entirely.
    const bLive = liveFor("ps_b", "b text");
    const next = guardStaleLiveUpdate("ps_b", "ps_a", bLive, (p) => ({
      ...(p as FakeLive),
      text: "stale A event",
    }));
    expect(next).toBe(bLive);
  });

  it("never lets a stale reader resurrect a cleared live view", () => {
    // Navigation clears live to null; a late event from the old reader must not recreate it.
    const next = guardStaleLiveUpdate<FakeLive | null>("ps_b", "ps_a", null, () =>
      liveFor("ps_a", "late event"),
    );
    expect(next).toBeNull();
  });

  it("keeps two interleaved readers isolated: only the current session's events land", () => {
    // The regression scenario: start a turn in A, navigate to B mid-stream, start a turn
    // in B. Both readers fold into the SAME shared state slot; A's remaining events must
    // all fall on the floor.
    let currentSession = "ps_a";
    let shared: FakeLive | null = null;
    const applyFor =
      (forSession: string) => (fn: (p: FakeLive | null) => FakeLive | null) => {
        shared = guardStaleLiveUpdate(currentSession, forSession, shared, fn);
      };
    const applyA = applyFor("ps_a");

    applyA(() => liveFor("ps_a"));
    applyA((p) => p && { ...p, text: "A chunk 1" });
    expect(shared).toMatchObject({ playgroundSessionId: "ps_a" });

    // Navigate to B (the component's effect also clears state and aborts A's fetch —
    // but even without the abort, the guard alone must protect B).
    currentSession = "ps_b";
    shared = null;
    const applyB = applyFor("ps_b");
    applyB(() => liveFor("ps_b"));

    applyA((p) => p && { ...p, text: "A chunk 2" }); // stale stream event
    applyA((p) => p && { ...p, done: true }); // stale done/error path
    applyB((p) => p && { ...p, text: "B chunk 1" });

    expect(shared).toEqual({
      playgroundSessionId: "ps_b",
      text: "B chunk 1",
      done: false,
    });
  });
});
