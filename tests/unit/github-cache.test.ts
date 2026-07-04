/**
 * SWR cache semantics (M5.9) — tested against the generic cache directly, never through
 * octokit. Pins the contract loaders rely on: miss blocks and stores, fresh hits skip the
 * fetcher, stale returns the old value immediately while refreshing in the background, a failed
 * background refresh keeps the stale value, concurrent gets share one fetch, and
 * invalidate/set/warm behave.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SwrCache } from "~/github/cache.server";

const TTL = 1_000;

let cache: SwrCache;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  cache = new SwrCache();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SwrCache", () => {
  it("miss blocks on the fetcher and caches the result", async () => {
    const fetcher = vi.fn().mockResolvedValue("v1");
    expect(await cache.get("k", TTL, fetcher)).toBe("v1");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("fresh hit does not call the fetcher again", async () => {
    const fetcher = vi.fn().mockResolvedValue("v1");
    await cache.get("k", TTL, fetcher);

    vi.setSystemTime(TTL - 1); // still within ttl
    expect(await cache.get("k", TTL, fetcher)).toBe("v1");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("stale returns the old value immediately, then background-revalidates", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce("v1")
      .mockResolvedValueOnce("v2");
    await cache.get("k", TTL, fetcher);

    vi.setSystemTime(TTL + 1); // now stale
    // Returns the STALE value synchronously (no await of the fresh fetch).
    expect(await cache.get("k", TTL, fetcher)).toBe("v1");
    expect(fetcher).toHaveBeenCalledTimes(2); // background refresh kicked off

    await vi.advanceTimersByTimeAsync(0); // flush the background promise
    // Next read (still within the new ttl window) sees the revalidated value.
    expect(await cache.get("k", TTL, fetcher)).toBe("v2");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps the stale value when the background revalidation fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce("v1")
      .mockRejectedValueOnce(new Error("github down"));
    await cache.get("k", TTL, fetcher);

    vi.setSystemTime(TTL + 1);
    expect(await cache.get("k", TTL, fetcher)).toBe("v1"); // stale returned
    await vi.advanceTimersByTimeAsync(0); // background rejects

    // Value survives the failure; the failure was logged, not thrown into nowhere.
    vi.setSystemTime(TTL + 1); // keep this read stale so it doesn't refetch mid-assert
    expect(await cache.get("k", TTL, () => Promise.resolve("unused"))).toBe("v1");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("dedupes concurrent gets into a single fetch", async () => {
    let resolve!: (v: string) => void;
    const fetcher = vi.fn(() => new Promise<string>((r) => (resolve = r)));

    const p1 = cache.get("k", TTL, fetcher);
    const p2 = cache.get("k", TTL, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1); // one fetch shared by both

    resolve("v1");
    expect(await p1).toBe("v1");
    expect(await p2).toBe("v1");
  });

  it("invalidate drops every key under the prefix", async () => {
    const fetcher = vi.fn().mockResolvedValue("v");
    await cache.get("src:1:a/b:@default", TTL, fetcher);
    await cache.get("src:1:a/b:feature", TTL, fetcher);
    await cache.get("prs:1:a/b", TTL, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(3);

    cache.invalidate("src:1:a/b:");

    // The two src entries are gone → refetch; the prs entry survives (fresh).
    await cache.get("src:1:a/b:@default", TTL, fetcher);
    await cache.get("src:1:a/b:feature", TTL, fetcher);
    await cache.get("prs:1:a/b", TTL, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it("a fetch in flight when invalidate() runs is not written back", async () => {
    let resolve!: (v: string) => void;
    const fetcher = vi.fn(() => new Promise<string>((r) => (resolve = r)));

    // A read starts (e.g. a stale revalidation)… then a write invalidates the key before the
    // fetch lands. The pre-write result must not resurrect into the cache for another TTL.
    const read = cache.get("prs:1:a/b", TTL, fetcher);
    cache.invalidate("prs:1:a/b");
    resolve("pre-write");
    expect(await read).toBe("pre-write"); // the joined caller still gets its read

    const fresh = vi.fn().mockResolvedValue("post-write");
    expect(await cache.get("prs:1:a/b", TTL, fresh)).toBe("post-write");
    expect(fresh).toHaveBeenCalledTimes(1); // cache was empty — the stale result never landed
  });

  it("set warms an entry that then serves as a fresh hit", async () => {
    cache.set("k", "warmed");
    const fetcher = vi.fn().mockResolvedValue("fetched");
    expect(await cache.get("k", TTL, fetcher)).toBe("warmed");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
