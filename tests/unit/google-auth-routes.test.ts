import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: {
    user: { id: "user-owner", email: "owner@example.com" },
    session: { id: "session-owner" },
    organizationId: "org-owner",
    requestHeaders: new Headers(),
  },
  exchangeCode: vi.fn(),
  findGrant: vi.fn(),
  getAgentSource: vi.fn(),
  getGoogleOAuthConfig: vi.fn(),
  listAgents: vi.fn(),
  listDrafts: vi.fn(),
  requireProject: vi.fn(),
}));

vi.mock("~/auth/session.server", () => ({
  sessionLoader: async (
    _args: unknown,
    callback: (input: { auth: typeof mocks.auth }) => Promise<object>,
  ) => ({
    ...(await callback({ auth: mocks.auth })),
    user: mocks.auth.user,
  }),
}));

vi.mock("~/connections/config.server", () => ({
  getGoogleOAuthConfig: mocks.getGoogleOAuthConfig,
}));

vi.mock("~/connections/grants.server", () => ({
  findGrant: mocks.findGrant,
  upsertGrant: vi.fn(),
}));

vi.mock("~/connections/google.server", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("~/connections/google.server")>();
  return { ...actual, exchangeCode: mocks.exchangeCode };
});

vi.mock("~/db/queries.server", () => ({ listAgents: mocks.listAgents }));
vi.mock("~/drafts/drafts.server", () => ({ listDrafts: mocks.listDrafts }));
vi.mock("~/github/cached.server", () => ({
  getAgentSource: mocks.getAgentSource,
}));
vi.mock("~/lib/ingress", () => ({
  publicOrigin: () => "https://eden.example.com",
}));
vi.mock("~/project/guard.server", () => ({
  requireProject: mocks.requireProject,
  requireRepo: (project: unknown) => project,
}));

process.env.EDEN_SECRETS_KEY =
  "1f8b16e6a46dd3ac12ef7a328f1ce35c67b5bc8f1acdd76280e3674c3a4f19b2";

const PROJECT = {
  id: "projabcdefgh",
  orgId: "org-owner",
  repoInstallationId: "1234",
  repoOwner: "zero8ai",
  repoName: "example",
};
const AGENT = {
  id: "agntabcdefgh",
  name: "agent",
  root: "agent",
  kind: "member",
};
const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

function routeArgs(url: string) {
  const request = new Request(url);
  return {
    request,
    url: new URL(url),
    pattern: new URL(url).pathname,
    params: {},
    context: {} as never,
  };
}

function effectiveLock() {
  return JSON.stringify({
    version: 1,
    installs: [
      {
        id: "google-sheets",
        type: "connection",
        name: "Google Sheets",
        version: "1.0.0",
        hash: "hash",
        registry: "fixture",
        member: null,
        files: [],
        auth: [{ provider: "google", kind: "oauth2", scopes: [SHEETS_SCOPE] }],
      },
    ],
  });
}

describe("Google routes with Better Auth", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.exchangeCode.mockReset();
    mocks.findGrant.mockReset().mockResolvedValue(null);
    mocks.getAgentSource.mockReset().mockResolvedValue({
      files: { "eden-lock.json": effectiveLock() },
      paths: [],
    });
    mocks.getGoogleOAuthConfig.mockReset().mockReturnValue({
      clientId: "google-client",
      clientSecret: "google-secret",
    });
    mocks.listAgents.mockReset().mockResolvedValue([AGENT]);
    mocks.listDrafts.mockReset().mockResolvedValue([]);
    mocks.requireProject.mockReset().mockResolvedValue(PROJECT);
  });

  it("binds state to the Better Auth user/session and ignores browser-supplied scopes", async () => {
    const { loader } = await import("~/routes/google.connect");
    const { connectStateKey, verifyConnectState } =
      await import("~/connections/google.server");
    const operation = loader(
      routeArgs(
        "https://eden.example.com/google/connect?project=projabcdefgh&agent=agent" +
          "&scopes=https%3A%2F%2Fmail.google.com%2F&returnTo=%2Fdashboard",
      ),
    );

    let response: Response | undefined;
    try {
      await operation;
    } catch (error) {
      if (error instanceof Response) response = error;
      else throw error;
    }
    expect(response?.status).toBe(302);

    const location = new URL(response!.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(location.searchParams.get("scope")).toContain(SHEETS_SCOPE);
    expect(location.searchParams.get("scope")).not.toContain(
      "https://mail.google.com/",
    );
    const state = verifyConnectState(
      location.searchParams.get("state")!,
      connectStateKey(),
    );
    expect(state).toMatchObject({
      projectId: PROJECT.id,
      agentId: AGENT.id,
      userId: mocks.auth.user.id,
      sessionId: mocks.auth.session.id,
      provider: "google",
      scopes: SHEETS_SCOPE,
    });
    expect(mocks.requireProject).toHaveBeenCalledWith(mocks.auth, PROJECT.id);
  });

  it("rejects a callback initiated by another Better Auth session before exchange", async () => {
    const { loader } = await import("~/routes/google.callback");
    const { connectStateKey, signConnectState } =
      await import("~/connections/google.server");
    const state = signConnectState(
      {
        projectId: PROJECT.id,
        agentId: AGENT.id,
        userId: "another-user",
        sessionId: "another-session",
        provider: "google",
        scopes: SHEETS_SCOPE,
        returnTo: "/dashboard",
        exp: Date.now() + 60_000,
      },
      connectStateKey(),
    );

    const result = await loader(
      routeArgs(
        `https://eden.example.com/google/callback?code=one-time-code&state=${encodeURIComponent(state)}`,
      ),
    );
    expect(result).toMatchObject({
      error: expect.stringContaining("different Eden session"),
      backUrl: "/dashboard",
      user: mocks.auth.user,
    });
    expect(mocks.requireProject).not.toHaveBeenCalled();
    expect(mocks.exchangeCode).not.toHaveBeenCalled();
  });
});
