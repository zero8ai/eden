/**
 * Capability credential handling (issue #166) — the control-plane side that keeps a rotating
 * grant alive under per-call load, and the deploy behavior that keeps the credential OUT of the
 * container:
 *
 *  - `capabilityAccessToken`: serves only `credentialDelivery: "capability"` providers; caches
 *    the access token per grant until shortly before `expiresAt` (Xero burns one rotation per
 *    refresh — refreshing per call would also race concurrent calls); concurrent calls share ONE
 *    refresh (the queued task finds the leader's cached token); sequential calls after expiry
 *    consume the PERSISTED rotated refresh token (two calls succeed against a rotate-on-refresh
 *    fake); a dead grant surfaces the reconnect message and drops the cache entry.
 *  - `connectionGrantEnv`: a capability provider's deploy injects NO `<PREFIX>_OAUTH_*` vars —
 *    only the Eden-owned `EDEN_CAPABILITY_PROVIDERS` marker — but still liveness-validates the
 *    grant (dead → readable throw) and requires the resource binding when the capability
 *    declares one.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  capabilityAccessToken,
  clearCapabilityTokenCache,
  type BrokerDeps,
} from "~/connections/broker.server";
import {
  connectionGrantEnv,
  type ConnectionDeployDeps,
} from "~/connections/deploy.server";
import { InvalidGrantError } from "~/connections/oauth.server";

const SCOPE = { projectId: "projabcdefgh", agentId: "agntabcdefgh" };
const okFetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;

const XERO_SCOPES =
  "offline_access accounting.transactions accounting.contacts accounting.settings.read accounting.attachments";

function brokerDeps(over: Partial<BrokerDeps>): BrokerDeps {
  return {
    getConfig: () => ({ clientId: "xero_client", clientSecret: "xero_secret" }),
    openRefreshToken: async () => ({
      grant: { id: "grant_xero", status: "active", scopes: XERO_SCOPES, clientId: null },
      refreshToken: "rt_1",
      tokenVersion: "iv_1",
    }),
    markGrantStatus: async () => {},
    rotateRefreshToken: async () => true,
    refreshAccessToken: async () => ({
      accessToken: "at_1",
      expiresIn: 1800,
      refreshToken: "rt_2",
    }),
    ...over,
  };
}

/** A rotate-on-refresh Xero fake: single-use refresh tokens, reuse kills the family (#167). */
function rotatingXero() {
  let stored = "rt_1";
  const spent = new Set<string>();
  let mint = 1;
  const events: string[] = [];
  const deps = brokerDeps({
    openRefreshToken: async () => {
      events.push(`open:${stored}`);
      return {
        grant: { id: "grant_xero", status: "active", scopes: XERO_SCOPES, clientId: null },
        refreshToken: stored,
        tokenVersion: `iv:${stored}`,
      };
    },
    refreshAccessToken: async (input) => {
      if (spent.has(input.refreshToken)) {
        // Family-reuse revocation — the exact failure the persistence discipline prevents.
        throw new InvalidGrantError("refresh token reuse — family revoked");
      }
      spent.add(input.refreshToken);
      events.push(`refresh:${input.refreshToken}`);
      mint += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { accessToken: `at_${mint}`, expiresIn: 1800, refreshToken: `rt_${mint}` };
    },
    rotateRefreshToken: async (_id, rt) => {
      events.push(`rotate:${rt}`);
      stored = rt;
      return true;
    },
  });
  return { deps, events };
}

afterEach(() => {
  clearCapabilityTokenCache();
});

describe("capabilityAccessToken", () => {
  it("refuses an unknown provider and every non-capability delivery (google, mayi)", async () => {
    for (const provider of ["notaprovider", "google", "mayi"]) {
      const out = await capabilityAccessToken(
        { ...SCOPE, provider },
        okFetch,
        brokerDeps({}),
      );
      expect(out).toMatchObject({ ok: false, status: 404 });
    }
  });

  it("persists the rotation BEFORE releasing the token, so two sequential refreshes both succeed against a rotate-on-refresh provider", async () => {
    const { deps, events } = rotatingXero();
    let clock = Date.now();
    const now = () => clock;

    const first = await capabilityAccessToken({ ...SCOPE, provider: "xero" }, okFetch, deps, now);
    expect(first.ok).toBe(true);
    // Force the cache stale: the second call MUST refresh — and must consume rt_2, not rt_1.
    clock += 1801 * 1000;
    const second = await capabilityAccessToken({ ...SCOPE, provider: "xero" }, okFetch, deps, now);
    expect(second.ok).toBe(true);
    expect(events).toEqual([
      "open:rt_1",
      "refresh:rt_1",
      "rotate:rt_2",
      "open:rt_2",
      "refresh:rt_2",
      "rotate:rt_3",
    ]);
  });

  it("caches the access token until shortly before expiresAt — a second call spends NO rotation", async () => {
    const { deps, events } = rotatingXero();
    const first = await capabilityAccessToken({ ...SCOPE, provider: "xero" }, okFetch, deps);
    const second = await capabilityAccessToken({ ...SCOPE, provider: "xero" }, okFetch, deps);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.accessToken).toBe(first.accessToken);
    expect(events.filter((e) => e.startsWith("refresh:"))).toEqual(["refresh:rt_1"]);
  });

  it("shares ONE refresh across concurrent calls — the queued task finds the leader's token in the cache", async () => {
    const { deps, events } = rotatingXero();
    const [a, b, c] = await Promise.all([
      capabilityAccessToken({ ...SCOPE, provider: "xero" }, okFetch, deps),
      capabilityAccessToken({ ...SCOPE, provider: "xero" }, okFetch, deps),
      capabilityAccessToken({ ...SCOPE, provider: "xero" }, okFetch, deps),
    ]);
    expect(a.ok && b.ok && c.ok).toBe(true);
    if (!a.ok || !b.ok || !c.ok) return;
    expect(b.accessToken).toBe(a.accessToken);
    expect(c.accessToken).toBe(a.accessToken);
    // Exactly one rotation for three calls — the whole point of the control-plane cache.
    expect(events.filter((e) => e.startsWith("refresh:"))).toEqual(["refresh:rt_1"]);
  });

  it("keeps caches per grant scope — another agent's token is never served", async () => {
    const { deps } = rotatingXero();
    const a = await capabilityAccessToken({ ...SCOPE, provider: "xero" }, okFetch, deps);
    const b = await capabilityAccessToken(
      { projectId: SCOPE.projectId, agentId: "agntdifferent", provider: "xero" },
      okFetch,
      deps,
    );
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.accessToken).not.toBe(a.accessToken);
  });

  it("surfaces a dead grant with the reconnect message and drops the cache entry", async () => {
    const markGrantStatus = vi.fn(async () => {});
    const out = await capabilityAccessToken(
      { ...SCOPE, provider: "xero" },
      okFetch,
      brokerDeps({
        markGrantStatus,
        refreshAccessToken: async () => {
          throw new InvalidGrantError("expired after 60 days");
        },
      }),
    );
    expect(out).toMatchObject({ ok: false, status: 403 });
    expect(out.ok === false && out.error).toMatch(/Xero connection.*expired — reconnect/);
    expect(markGrantStatus).toHaveBeenCalledWith("grant_xero", "expired", "iv_1");
  });
});

/* ─────────────────────────── deploy behavior for capability providers ─────────────────────────── */

const deployScope = { ...SCOPE, environmentId: "envabcdefghi" };

function deployDeps(over: Partial<ConnectionDeployDeps>): ConnectionDeployDeps {
  return {
    getConfig: () => ({ clientId: "xero_client", clientSecret: "xero_secret" }),
    listGrantsForAgent: async () => [{ provider: "xero", status: "active" as const }],
    openRefreshToken: async () => ({
      grant: {
        id: "grant_xero",
        status: "active",
        scopes: XERO_SCOPES,
        resourceId: "tenant-1",
      },
      refreshToken: "rt_1",
      tokenVersion: "iv_1",
    }),
    markGrantStatus: async () => {},
    rotateRefreshToken: async () => true,
    refreshAccessToken: async () => ({
      accessToken: "at_1",
      expiresIn: 1800,
      refreshToken: "rt_2",
    }),
    ...over,
  };
}

describe("connectionGrantEnv — capability delivery (issue #166)", () => {
  it("injects NO XERO_OAUTH_* vars — only the Eden-owned capability marker", async () => {
    const out = await connectionGrantEnv(deployScope, okFetch, deployDeps({}));
    expect(Object.keys(out).filter((k) => k.startsWith("XERO"))).toEqual([]);
    expect(out).toEqual({ EDEN_CAPABILITY_PROVIDERS: "xero" });
  });

  it("still liveness-validates the grant with the rotation persisted (Eden stays the single writer)", async () => {
    const order: string[] = [];
    const rotateRefreshToken = vi.fn(async (_id: string, rt: string) => {
      order.push(`rotate:${rt}`);
      return true;
    });
    const out = await connectionGrantEnv(
      deployScope,
      okFetch,
      deployDeps({ rotateRefreshToken }),
    );
    expect(rotateRefreshToken).toHaveBeenCalledWith("grant_xero", "rt_2", "iv_1");
    // The rotated token was persisted — and still nothing credential-shaped got injected.
    expect(out).toEqual({ EDEN_CAPABILITY_PROVIDERS: "xero" });
  });

  it("fails the deploy honestly on a dead grant (marked expired, readable reconnect throw)", async () => {
    const markGrantStatus = vi.fn(async () => {});
    await expect(
      connectionGrantEnv(
        deployScope,
        okFetch,
        deployDeps({
          markGrantStatus,
          refreshAccessToken: async () => {
            throw new InvalidGrantError("dead");
          },
        }),
      ),
    ).rejects.toThrow(/The Xero connection for this agent has expired/);
    expect(markGrantStatus).toHaveBeenCalledWith("grant_xero", "expired", "iv_1");
  });

  it("fails the deploy when the capability's resource binding is missing (unbound grant is unusable)", async () => {
    await expect(
      connectionGrantEnv(
        deployScope,
        okFetch,
        deployDeps({
          openRefreshToken: async () => ({
            grant: {
              id: "grant_xero",
              status: "active",
              scopes: XERO_SCOPES,
              resourceId: null,
            },
            refreshToken: "rt_1",
            tokenVersion: "iv_1",
          }),
        }),
      ),
    ).rejects.toThrow(/isn't bound to an organisation/);
  });

  it("leaves refresh-token providers byte-identical (google regression)", async () => {
    const out = await connectionGrantEnv(
      deployScope,
      okFetch,
      deployDeps({
        listGrantsForAgent: async () => [{ provider: "google", status: "active" as const }],
        openRefreshToken: async () => ({
          grant: {
            id: "grant_g",
            status: "active",
            scopes: "https://www.googleapis.com/auth/spreadsheets",
          },
          refreshToken: "rt_g",
        }),
        refreshAccessToken: async () => ({ accessToken: "at", expiresIn: 3599 }),
      }),
    );
    expect(out).toEqual({
      GOOGLE_OAUTH_CLIENT_ID: "xero_client",
      GOOGLE_OAUTH_CLIENT_SECRET: "xero_secret",
      GOOGLE_OAUTH_REFRESH_TOKEN: "rt_g",
      GOOGLE_OAUTH_SCOPES: "https://www.googleapis.com/auth/spreadsheets",
    });
    expect(out.EDEN_CAPABILITY_PROVIDERS).toBeUndefined();
  });
});
