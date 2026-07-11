/**
 * The central token-refresh path (issue #28), `getFreshAccessToken`, against injected deps — no DB.
 * Pins: a still-fresh token short-circuits (zero refresh calls), an expiring token refreshes and
 * persists the rotated refresh token, invalid_grant marks the connection expired + rethrows, a
 * non-active connection throws, and concurrent calls collapse onto a single upstream refresh.
 */
import { describe, expect, it, vi } from "vitest";

import { InvalidGrantError } from "~/connections/codex.server";
import {
  getFreshAccessToken,
  REFRESH_MARGIN_MS,
  type GatewayConnection,
} from "~/models/provider-connections.server";

const NOW = 1_000_000_000_000;

function conn(overrides: Partial<GatewayConnection> = {}): GatewayConnection {
  return {
    id: "conn_1",
    orgId: "org_1",
    provider: "codex",
    status: "active",
    accountId: "acct_1",
    accessToken: "fresh-access",
    refreshToken: "refresh-1",
    accessTokenExpiresAt: new Date(NOW + 60 * 60 * 1000),
    ...overrides,
  };
}

describe("getFreshAccessToken", () => {
  it("short-circuits a still-fresh token without refreshing", async () => {
    const refresh = vi.fn();
    const result = await getFreshAccessToken("conn_1", {
      load: async () => conn(),
      refresh: refresh as never,
      now: () => NOW,
    });
    expect(result).toEqual({ accessToken: "fresh-access", accountId: "acct_1" });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes an expiring token and persists the rotated refresh token", async () => {
    const persisted: unknown[] = [];
    const result = await getFreshAccessToken("conn_1", {
      load: async () =>
        conn({ accessTokenExpiresAt: new Date(NOW + REFRESH_MARGIN_MS - 1000) }),
      refresh: async () => ({
        accessToken: "new-access",
        refreshToken: "refresh-2",
        idToken: null,
        expiresIn: 3600,
      }),
      persist: async (id, tokens) => {
        persisted.push({ id, tokens });
      },
      now: () => NOW,
    });
    expect(result.accessToken).toBe("new-access");
    expect(persisted).toEqual([
      {
        id: "conn_1",
        tokens: {
          accessToken: "new-access",
          refreshToken: "refresh-2",
          expiresAt: new Date(NOW + 3600 * 1000),
        },
      },
    ]);
  });

  it("marks the connection expired and rethrows on invalid_grant", async () => {
    const marked: Array<[string, string]> = [];
    await expect(
      getFreshAccessToken("conn_1", {
        load: async () => conn({ accessTokenExpiresAt: new Date(NOW - 1000) }),
        refresh: async () => {
          throw new InvalidGrantError("dead");
        },
        markStatus: async (id, status) => {
          marked.push([id, status]);
        },
        now: () => NOW,
      }),
    ).rejects.toBeInstanceOf(InvalidGrantError);
    expect(marked).toEqual([["conn_1", "expired"]]);
  });

  it("throws for a non-active connection without calling refresh", async () => {
    const refresh = vi.fn();
    await expect(
      getFreshAccessToken("conn_1", {
        load: async () => conn({ status: "expired" }),
        refresh: refresh as never,
        now: () => NOW,
      }),
    ).rejects.toBeInstanceOf(InvalidGrantError);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("collapses concurrent refreshes onto a single upstream call (single-flight)", async () => {
    const refresh = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return {
        accessToken: "shared-access",
        refreshToken: "refresh-2",
        idToken: null,
        expiresIn: 3600,
      };
    });
    const load = async () =>
      conn({ id: "conn_sf", accessTokenExpiresAt: new Date(NOW - 1000) });
    const deps = { load, refresh, persist: async () => {}, now: () => NOW };
    const [a, b] = await Promise.all([
      getFreshAccessToken("conn_sf", deps),
      getFreshAccessToken("conn_sf", deps),
    ]);
    expect(a.accessToken).toBe("shared-access");
    expect(b.accessToken).toBe("shared-access");
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
