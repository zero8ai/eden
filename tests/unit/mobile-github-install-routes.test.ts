/** Route-level authorization tests for the native GitHub install handoff (issue #152). */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: {
    user: { id: "user-owner" },
    session: { id: "session-owner" },
    requestHeaders: new Headers(),
  },
  active: {
    org: { id: "org-owner", name: "Owner workspace", slug: "owner" },
  } as { org: { id: string; name: string; slug: string } } | null,
  consumeMobileGithubHandoff: vi.fn(),
  consumeOAuthStateNonce: vi.fn(),
  createMobileGithubHandoff: vi.fn(),
  createOAuthStateNonce: vi.fn(),
  exchangeGithubUserCode: vi.fn(),
  getInstallUrl: vi.fn(),
  githubUserCanAccessInstallation: vi.fn(),
  listKnownInstallations: vi.fn(),
  rememberInstallation: vi.fn(),
  resolveInstallationGrant: vi.fn(),
  resolveActiveWorkspace: vi.fn(),
  webConnectAction: vi.fn(),
  webConnectLoader: vi.fn(),
}));

vi.mock("~/auth/session.server", () => ({
  getSessionAuth: async () => mocks.auth,
}));

vi.mock("~/auth/workspace.server", () => ({
  resolveActiveWorkspace: mocks.resolveActiveWorkspace,
}));

vi.mock("~/connections/oauth-state.server", () => ({
  consumeOAuthStateNonce: mocks.consumeOAuthStateNonce,
  createOAuthStateNonce: mocks.createOAuthStateNonce,
}));

vi.mock("~/github/client.server", () => ({
  getGitHubUserOAuthConfig: () => ({
    clientId: "github-client",
    clientSecret: "github-secret",
  }),
  getInstallUrl: mocks.getInstallUrl,
}));

vi.mock("~/github/installations.server", () => ({
  listKnownInstallations: mocks.listKnownInstallations,
  rememberInstallation: mocks.rememberInstallation,
  resolveInstallationGrant: mocks.resolveInstallationGrant,
}));

vi.mock("~/github/mobile-install.server", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("~/github/mobile-install.server")>();
  return {
    ...actual,
    consumeMobileGithubHandoff: mocks.consumeMobileGithubHandoff,
    createMobileGithubHandoff: mocks.createMobileGithubHandoff,
    exchangeGithubUserCode: mocks.exchangeGithubUserCode,
    githubUserCanAccessInstallation: mocks.githubUserCanAccessInstallation,
  };
});

vi.mock("~/lib/ingress", () => ({
  publicOrigin: () => "https://eden.example.com",
}));

vi.mock("~/routes/connect", () => ({
  action: mocks.webConnectAction,
  loader: mocks.webConnectLoader,
}));

const KEY = Buffer.from(
  "1f8b16e6a46dd3ac12ef7a328f1ce35c67b5bc8f1acdd76280e3674c3a4f19b2",
  "hex",
);
process.env.EDEN_SECRETS_KEY = KEY.toString("hex");

function routeArgs(url: string, init?: RequestInit) {
  const request = new Request(url, init);
  return {
    request,
    url: new URL(url),
    pattern: new URL(url).pathname,
    params: {},
    context: {} as never,
  };
}

function formRequest(
  path: string,
  values: Record<string, string>,
): ReturnType<typeof routeArgs> {
  return routeArgs(`https://eden.example.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values),
  });
}

async function thrownResponse(operation: Promise<unknown>): Promise<Response> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  throw new Error("Expected the route to throw a Response");
}

async function verifyStateToken(input?: {
  exp?: number;
  orgId?: string;
  userId?: string;
  sessionId?: string;
}) {
  const { signMobileGithubState } =
    await import("~/github/mobile-install.server");
  return signMobileGithubState(
    {
      provider: "github-mobile-install",
      phase: "verify",
      installationId: "4242",
      orgId: input?.orgId ?? "org-owner",
      userId: input?.userId ?? "user-owner",
      sessionId: input?.sessionId ?? "session-owner",
      nonce: "nonce-owner",
      redirectUrl: "eden://connect",
      exp: input?.exp ?? Date.now() + 60_000,
    },
    KEY,
  );
}

describe("native GitHub installation routes", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.auth.user.id = "user-owner";
    mocks.auth.session.id = "session-owner";
    mocks.active = {
      org: { id: "org-owner", name: "Owner workspace", slug: "owner" },
    };
    mocks.consumeMobileGithubHandoff.mockReset().mockResolvedValue(null);
    mocks.consumeOAuthStateNonce.mockReset().mockResolvedValue(true);
    mocks.createMobileGithubHandoff
      .mockReset()
      .mockResolvedValue("opaque-handoff");
    mocks.createOAuthStateNonce.mockReset().mockResolvedValue("nonce-owner");
    mocks.exchangeGithubUserCode
      .mockReset()
      .mockResolvedValue("github-user-token");
    mocks.getInstallUrl
      .mockReset()
      .mockImplementation(
        (state: string) =>
          `https://github.com/apps/eden/installations/new?state=${encodeURIComponent(state)}`,
      );
    mocks.githubUserCanAccessInstallation.mockReset().mockResolvedValue(true);
    mocks.listKnownInstallations.mockReset().mockResolvedValue([]);
    mocks.rememberInstallation.mockReset().mockResolvedValue(undefined);
    mocks.resolveInstallationGrant.mockReset().mockResolvedValue(null);
    mocks.resolveActiveWorkspace
      .mockReset()
      .mockImplementation(async () => mocks.active);
    mocks.webConnectAction.mockReset();
    mocks.webConnectLoader.mockReset().mockResolvedValue({
      org: { id: "org-owner", name: "Owner workspace" },
      github: { state: "install", installUrl: "/github/install/start" },
    });
  });

  it("starts with signed state bound to the native user, session, organization, and redirect", async () => {
    const { action } = await import("~/routes/api.mobile.github-install.start");
    const { verifyMobileGithubState } =
      await import("~/github/mobile-install.server");

    const result = await action(
      formRequest("/api/mobile/github/install/start", {
        redirectUrl: "eden://connect",
      }),
    );
    const authUrl = new URL((result as { authUrl: string }).authUrl);
    const state = verifyMobileGithubState(
      authUrl.searchParams.get("state")!,
      KEY,
    );

    expect(state).toMatchObject({
      phase: "setup",
      orgId: "org-owner",
      userId: "user-owner",
      sessionId: "session-owner",
      nonce: "nonce-owner",
      redirectUrl: "eden://connect",
    });
    expect(mocks.createOAuthStateNonce).toHaveBeenCalledWith({
      userId: "user-owner",
      sessionId: "session-owner",
      expiresAt: expect.any(Date),
    });
  });

  it("rejects an expired state before consuming a nonce or calling GitHub", async () => {
    const { loader } = await import("~/routes/github.mobile-install.callback");
    const state = await verifyStateToken({ exp: Date.now() - 1 });

    const result = await loader(
      routeArgs(
        `https://eden.example.com/github/mobile-install/callback?code=oauth-code&state=${encodeURIComponent(state)}`,
      ),
    );

    expect(result).toMatchObject({
      error: expect.stringMatching(/invalid|expired/i),
    });
    expect(mocks.consumeOAuthStateNonce).not.toHaveBeenCalled();
    expect(mocks.exchangeGithubUserCode).not.toHaveBeenCalled();
  });

  it("rejects a wrong or replayed nonce before OAuth exchange", async () => {
    mocks.consumeOAuthStateNonce.mockResolvedValue(false);
    const { loader } = await import("~/routes/github.mobile-install.callback");
    const state = await verifyStateToken();

    const response = await thrownResponse(
      loader(
        routeArgs(
          `https://eden.example.com/github/mobile-install/callback?code=oauth-code&state=${encodeURIComponent(state)}`,
        ),
      ),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("error=expired");
    expect(mocks.consumeOAuthStateNonce).toHaveBeenCalledWith({
      nonce: "nonce-owner",
      userId: "user-owner",
      sessionId: "session-owner",
    });
    expect(mocks.exchangeGithubUserCode).not.toHaveBeenCalled();
    expect(mocks.createMobileGithubHandoff).not.toHaveBeenCalled();
  });

  it("requires GitHub user-token access before issuing a native handoff", async () => {
    mocks.githubUserCanAccessInstallation.mockResolvedValue(false);
    const { loader } = await import("~/routes/github.mobile-install.callback");
    const state = await verifyStateToken();

    const response = await thrownResponse(
      loader(
        routeArgs(
          `https://eden.example.com/github/mobile-install/callback?code=oauth-code&state=${encodeURIComponent(state)}`,
        ),
      ),
    );

    expect(mocks.githubUserCanAccessInstallation).toHaveBeenCalledWith(
      "github-user-token",
      "4242",
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain(
      "error=verification_failed",
    );
    expect(mocks.createMobileGithubHandoff).not.toHaveBeenCalled();
  });

  it("issues only an opaque handoff after nonce and ownership verification", async () => {
    const { loader } = await import("~/routes/github.mobile-install.callback");
    const state = await verifyStateToken();

    const response = await thrownResponse(
      loader(
        routeArgs(
          `https://eden.example.com/github/mobile-install/callback?code=oauth-code&state=${encodeURIComponent(state)}`,
        ),
      ),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "eden://connect?handoff=opaque-handoff",
    );
    expect(response.headers.get("location")).not.toContain("4242");
    expect(mocks.createMobileGithubHandoff).toHaveBeenCalledWith({
      installationId: "4242",
      orgId: "org-owner",
      userId: "user-owner",
      sessionId: "session-owner",
    });
  });

  it.each([
    ["user", "user-other", "session-owner", "org-owner"],
    ["session", "user-owner", "session-other", "org-owner"],
    ["organization", "user-owner", "session-owner", "org-other"],
  ])(
    "rejects a handoff that is not bound to the active %s",
    async (_label, userId, sessionId, orgId) => {
      mocks.auth.user.id = userId;
      mocks.auth.session.id = sessionId;
      mocks.active = {
        org: { id: orgId, name: "Other workspace", slug: "other" },
      };
      mocks.consumeMobileGithubHandoff.mockResolvedValue(null);
      const { action } =
        await import("~/routes/api.mobile.github-install.redeem");

      const result = await action(
        formRequest("/api/mobile/github/install/redeem", {
          handoff: "copied-handoff",
        }),
      );

      expect(result).toMatchObject({ init: { status: 403 } });
      expect(mocks.consumeMobileGithubHandoff).toHaveBeenCalledWith({
        code: "copied-handoff",
        orgId,
        userId,
        sessionId,
      });
      expect(mocks.rememberInstallation).not.toHaveBeenCalled();
    },
  );

  it("redeems once and persists only the server-returned installation", async () => {
    mocks.consumeMobileGithubHandoff
      .mockResolvedValueOnce("4242")
      .mockResolvedValueOnce(null);
    const { action } =
      await import("~/routes/api.mobile.github-install.redeem");
    const request = () =>
      formRequest("/api/mobile/github/install/redeem", {
        handoff: "single-use-handoff",
      });

    await expect(action(request())).resolves.toEqual({ ok: true });
    const replay = await action(request());

    expect(replay).toMatchObject({ init: { status: 403 } });
    expect(mocks.rememberInstallation).toHaveBeenCalledOnce();
    expect(mocks.rememberInstallation).toHaveBeenCalledWith(
      "org-owner",
      "4242",
    );
  });

  it.each(["installation_id", "installationId"])(
    "refuses raw %s in place of an opaque handoff",
    async (field) => {
      const { action } =
        await import("~/routes/api.mobile.github-install.redeem");

      const result = await action(
        formRequest("/api/mobile/github/install/redeem", { [field]: "4242" }),
      );

      expect(result).toMatchObject({ init: { status: 400 } });
      expect(mocks.consumeMobileGithubHandoff).not.toHaveBeenCalled();
      expect(mocks.rememberInstallation).not.toHaveBeenCalled();
    },
  );

  it.each(["installation_id", "installationId"])(
    "refuses raw %s at the mobile Connect API before the shared GitHub action",
    async (field) => {
      const { action } = await import("~/routes/api.mobile.connect");

      const result = await action(
        formRequest("/api/mobile/connect", {
          [field]: "4242",
          owner: "zero8ai",
          repo: "eve-example",
        }),
      );

      expect(result).toMatchObject({ init: { status: 403 } });
      expect(mocks.resolveInstallationGrant).not.toHaveBeenCalled();
      expect(mocks.webConnectAction).not.toHaveBeenCalled();
    },
  );

  it("refuses a raw installation_id query before invoking the shared web loader", async () => {
    const { loader } = await import("~/routes/api.mobile.connect");

    const result = await loader(
      routeArgs(
        "https://eden.example.com/api/mobile/connect?installation_id=4242&state=attacker-state",
      ),
    );

    expect(result).toMatchObject({ init: { status: 400 } });
    expect(mocks.webConnectLoader).not.toHaveBeenCalled();
    expect(mocks.rememberInstallation).not.toHaveBeenCalled();
  });

  it("derives the private installation id server-side from an opaque tenant grant", async () => {
    mocks.resolveInstallationGrant.mockResolvedValue({
      id: "grant-owner",
      installationId: "4242",
      accountLogin: "zero8ai",
    });
    mocks.webConnectAction.mockImplementation(
      async (args: { request: Request }) => {
        const form = await args.request.formData();
        return {
          installationId: form.get("installationId"),
          leakedGrant: form.get("installationGrantId"),
        };
      },
    );
    const { action } = await import("~/routes/api.mobile.connect");

    const result = await action(
      formRequest("/api/mobile/connect", {
        installationGrantId: "grant-owner",
        owner: "zero8ai",
        repo: "eve-example",
      }),
    );

    expect(mocks.resolveInstallationGrant).toHaveBeenCalledWith(
      "org-owner",
      "grant-owner",
    );
    expect(result).toEqual({ installationId: "4242", leakedGrant: null });
  });
});
