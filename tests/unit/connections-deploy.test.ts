/**
 * Deploy-side connection injection (issue #30). The decision logic: no config or no active grant →
 * {}; an active grant → the client-creds + refresh-token env trio (after a validating refresh); a
 * dead grant → status marked "expired" and a readable throw so the deploy fails honestly.
 */
import { describe, expect, it, vi } from "vitest";

import { connectionGrantEnv, type ConnectionDeployDeps } from "~/connections/deploy.server";
import { InvalidGrantError } from "~/connections/google.server";

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
      deps({ openRefreshToken: async () => null }),
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

  it("marks the grant expired and throws on invalid_grant", async () => {
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
    ).rejects.toThrow(/expired/i);
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
      "https://www.googleapis.com/auth/spreadsheets",
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
        "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file",
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
});
