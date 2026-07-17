/**
 * Deploy-side connection injection (issues #30, #163). The decision logic, per provider: no config
 * or no active grant → nothing; an active grant → the `<PREFIX>_OAUTH_*` client-creds +
 * refresh-token env trio (after a validating refresh); a dead grant → status marked "expired" and
 * a readable throw so the deploy fails honestly. Providers iterate over the UNION of the agent's
 * grant rows and the lock's required providers; unregistered ids are skipped silently.
 *
 * The registry is mocked to add a second provider ("hubspot") — the real registry ships only
 * google, and multi-provider behavior needs two.
 */
import { describe, expect, it, vi } from "vitest";

import { connectionGrantEnv, type ConnectionDeployDeps } from "~/connections/deploy.server";
import { InvalidGrantError } from "~/connections/oauth.server";
import type { ProviderDefinition } from "~/connections/providers.server";

const HUBSPOT: ProviderDefinition = {
  id: "hubspot",
  label: "HubSpot",
  authorizeUrl: "https://app.hubspot.com/oauth/authorize",
  tokenUrl: "https://api.hubapi.com/oauth/v1/token",
  envPrefix: "HUBSPOT",
};

vi.mock("~/connections/providers.server", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("~/connections/providers.server")>();
  return {
    ...actual,
    getProvider: (id: string) =>
      id === "hubspot" ? HUBSPOT : actual.getProvider(id),
    listProviders: () => [...actual.listProviders(), HUBSPOT],
  };
});

const scope = {
  projectId: "projabcdefgh",
  agentId: "agntabcdefgh",
  environmentId: "envabcdefghi",
};
const config = { clientId: "client_1", clientSecret: "secret_1" };
const okFetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;

function deps(over: Partial<ConnectionDeployDeps>): ConnectionDeployDeps {
  return {
    getConfig: () => config,
    listGrantsForAgent: async () => [
      { provider: "google", status: "active" as const },
    ],
    openRefreshToken: async () => ({
      grant: {
        id: "grant_1",
        status: "active",
        scopes: "https://www.googleapis.com/auth/spreadsheets",
      },
      refreshToken: "rt",
    }),
    markGrantStatus: async () => {},
    refreshAccessToken: async () => ({ accessToken: "at", expiresIn: 3599 }),
    ...over,
  };
}

describe("connectionGrantEnv", () => {
  it("returns {} when no operator config is set", async () => {
    const out = await connectionGrantEnv(scope, okFetch, deps({ getConfig: () => null }));
    expect(out).toEqual({});
  });

  it("returns {} when the agent has no grant", async () => {
    const out = await connectionGrantEnv(
      scope,
      okFetch,
      deps({
        listGrantsForAgent: async () => [],
        openRefreshToken: async () => null,
      }),
    );
    expect(out).toEqual({});
  });

  it("returns {} when the grant is not active", async () => {
    const out = await connectionGrantEnv(
      scope,
      okFetch,
      deps({
        openRefreshToken: async () => ({
          grant: { id: "g", status: "expired", scopes: "" },
          refreshToken: "rt",
        }),
      }),
    );
    expect(out).toEqual({});
  });

  it("returns the client-creds + refresh-token env trio for an active grant", async () => {
    const out = await connectionGrantEnv(scope, okFetch, deps({}));
    expect(out).toEqual({
      GOOGLE_OAUTH_CLIENT_ID: "client_1",
      GOOGLE_OAUTH_CLIENT_SECRET: "secret_1",
      GOOGLE_OAUTH_REFRESH_TOKEN: "rt",
    });
  });

  it("marks the grant expired and throws (naming the provider) on invalid_grant", async () => {
    const markGrantStatus = vi.fn(async () => {});
    await expect(
      connectionGrantEnv(
        scope,
        okFetch,
        deps({
          markGrantStatus,
          refreshAccessToken: async () => {
            throw new InvalidGrantError("dead");
          },
        }),
      ),
    ).rejects.toThrow(/The Google connection for this agent has expired/);
    expect(markGrantStatus).toHaveBeenCalledWith("grant_1", "expired");
  });

  it("propagates a transient refresh failure without marking the grant", async () => {
    const markGrantStatus = vi.fn(async () => {});
    await expect(
      connectionGrantEnv(
        scope,
        okFetch,
        deps({
          markGrantStatus,
          refreshAccessToken: async () => {
            throw new Error("HTTP 500");
          },
        }),
      ),
    ).rejects.toThrow(/500/);
    expect(markGrantStatus).not.toHaveBeenCalled();
  });

  it("returns the env trio when required scopes are fully covered by the grant (issue #69)", async () => {
    const out = await connectionGrantEnv(
      scope,
      okFetch,
      deps({
        openRefreshToken: async () => ({
          grant: {
            id: "grant_1",
            status: "active",
            scopes:
              "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file",
          },
          refreshToken: "rt",
        }),
      }),
      new Map([["google", ["https://www.googleapis.com/auth/spreadsheets"]]]),
    );
    expect(out).toEqual({
      GOOGLE_OAUTH_CLIENT_ID: "client_1",
      GOOGLE_OAUTH_CLIENT_SECRET: "secret_1",
      GOOGLE_OAUTH_REFRESH_TOKEN: "rt",
    });
  });

  it("throws (without expiring the grant) when required scopes aren't covered (issue #69)", async () => {
    const markGrantStatus = vi.fn(async () => {});
    await expect(
      connectionGrantEnv(
        scope,
        okFetch,
        deps({
          markGrantStatus,
          openRefreshToken: async () => ({
            grant: {
              id: "grant_1",
              status: "active",
              scopes: "https://www.googleapis.com/auth/spreadsheets",
            },
            refreshToken: "rt",
          }),
        }),
        new Map([
          [
            "google",
            [
              "https://www.googleapis.com/auth/spreadsheets",
              "https://www.googleapis.com/auth/drive.file",
            ],
          ],
        ]),
      ),
    ).rejects.toThrow(/missing required permission/i);
    // Under-scoped is not dead: the grant stays active.
    expect(markGrantStatus).not.toHaveBeenCalled();
  });

  it("skips the coverage check when requiredScopes is omitted (existing behavior preserved)", async () => {
    const out = await connectionGrantEnv(
      scope,
      okFetch,
      deps({
        openRefreshToken: async () => ({
          // Narrow grant that would fail a coverage check — but none is requested.
          grant: { id: "grant_1", status: "active", scopes: "openid" },
          refreshToken: "rt",
        }),
      }),
    );
    expect(out).toEqual({
      GOOGLE_OAUTH_CLIENT_ID: "client_1",
      GOOGLE_OAUTH_CLIENT_SECRET: "secret_1",
      GOOGLE_OAUTH_REFRESH_TOKEN: "rt",
    });
  });

  it("injects every provider with an active grant, under its own env prefix (issue #163)", async () => {
    const hubConfig = { clientId: "hub_client", clientSecret: "hub_secret" };
    const out = await connectionGrantEnv(
      scope,
      okFetch,
      deps({
        getConfig: (p) => (p.id === "hubspot" ? hubConfig : config),
        listGrantsForAgent: async () => [
          { provider: "google", status: "active" as const },
          { provider: "hubspot", status: "active" as const },
        ],
        openRefreshToken: async ({ provider }) => ({
          grant: { id: `grant_${provider}`, status: "active", scopes: "s" },
          refreshToken: `rt_${provider}`,
        }),
      }),
    );
    expect(out).toEqual({
      GOOGLE_OAUTH_CLIENT_ID: "client_1",
      GOOGLE_OAUTH_CLIENT_SECRET: "secret_1",
      GOOGLE_OAUTH_REFRESH_TOKEN: "rt_google",
      HUBSPOT_OAUTH_CLIENT_ID: "hub_client",
      HUBSPOT_OAUTH_CLIENT_SECRET: "hub_secret",
      HUBSPOT_OAUTH_REFRESH_TOKEN: "rt_hubspot",
    });
  });

  it("skips a lock-required provider that isn't in the registry (issue #163)", async () => {
    const openRefreshToken = vi.fn(
      async ({ provider }: { provider: string }) => ({
        grant: { id: `grant_${provider}`, status: "active" as const, scopes: "s" },
        refreshToken: `rt_${provider}`,
      }),
    );
    const out = await connectionGrantEnv(
      scope,
      okFetch,
      deps({ openRefreshToken }),
      new Map([["notaprovider", ["some.scope"]]]),
    );
    // The unregistered provider never reaches the grant store; google injects normally.
    expect(openRefreshToken).toHaveBeenCalledTimes(1);
    expect(out).toEqual({
      GOOGLE_OAUTH_CLIENT_ID: "client_1",
      GOOGLE_OAUTH_CLIENT_SECRET: "secret_1",
      GOOGLE_OAUTH_REFRESH_TOKEN: "rt_google",
    });
  });

  it("names the provider's label in a scope-coverage failure (issue #163)", async () => {
    const markGrantStatus = vi.fn(async () => {});
    await expect(
      connectionGrantEnv(
        scope,
        okFetch,
        deps({
          markGrantStatus,
          listGrantsForAgent: async () => [
            { provider: "hubspot", status: "active" as const },
          ],
          openRefreshToken: async () => ({
            grant: { id: "grant_hub", status: "active", scopes: "crm.read" },
            refreshToken: "rt_hub",
          }),
        }),
        new Map([["hubspot", ["crm.read", "crm.write"]]]),
      ),
    ).rejects.toThrow(
      /The HubSpot connection for this agent is missing required permission\(s\): crm\.write/,
    );
    // Under-scoped is not dead: the grant stays active.
    expect(markGrantStatus).not.toHaveBeenCalled();
  });

  it("still injects a granted provider the lock no longer requires (grants ∪ lock union)", async () => {
    const hubConfig = { clientId: "hub_client", clientSecret: "hub_secret" };
    const out = await connectionGrantEnv(
      scope,
      okFetch,
      deps({
        getConfig: (p) => (p.id === "hubspot" ? hubConfig : null),
        listGrantsForAgent: async () => [
          { provider: "hubspot", status: "active" as const },
        ],
        openRefreshToken: async () => ({
          grant: { id: "grant_hub", status: "active", scopes: "s" },
          refreshToken: "rt_hub",
        }),
      }),
      new Map([["google", ["https://www.googleapis.com/auth/spreadsheets"]]]),
    );
    // Google's config is null here → skipped; hubspot rides on its grant row alone.
    expect(out).toEqual({
      HUBSPOT_OAUTH_CLIENT_ID: "hub_client",
      HUBSPOT_OAUTH_CLIENT_SECRET: "hub_secret",
      HUBSPOT_OAUTH_REFRESH_TOKEN: "rt_hub",
    });
  });
});
