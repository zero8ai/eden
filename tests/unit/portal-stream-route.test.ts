/**
 * Portal stream action (issue #180): the guest door onto the turn pipeline. These tests pin the
 * gate ORDER and failure modes — anonymous 401, ungranted 403, rate-limited 429, org budget
 * 429, offline 409 — and that a passing request reaches streamTurnResponse on the "portal"
 * channel with the turn recorded.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionAuth: vi.fn(),
  getPortalBySlug: vi.fn(),
  findLiveGrant: vi.fn(),
  portalTurnCounts: vi.fn(),
  recordPortalTurn: vi.fn(),
  liveTargets: vi.fn(),
  streamTurnResponse: vi.fn(),
  createPlaygroundSession: vi.fn(),
  getPlaygroundSession: vi.fn(),
  markPlaygroundSessionRunning: vi.fn(),
  findWorkspaceModel: vi.fn(),
  signModelDirective: vi.fn(),
  findById: vi.fn(),
  checkBudget: vi.fn(),
}));

vi.mock("~/auth/session.server", () => ({
  getSessionAuth: mocks.getSessionAuth,
}));

vi.mock("~/portal/portals.server", () => ({
  getPortalBySlug: mocks.getPortalBySlug,
  findLiveGrant: mocks.findLiveGrant,
  portalTurnCounts: mocks.portalTurnCounts,
  recordPortalTurn: mocks.recordPortalTurn,
}));

vi.mock("~/chat/playground.server", () => ({
  liveTargets: mocks.liveTargets,
}));

vi.mock("~/chat/turn-stream.server", () => ({
  asString: (v: unknown) => (typeof v === "string" ? v : ""),
  streamTurnResponse: mocks.streamTurnResponse,
}));

vi.mock("~/playground/sessions.server", () => ({
  createPlaygroundSession: mocks.createPlaygroundSession,
  getPlaygroundSession: mocks.getPlaygroundSession,
  loadPlaygroundEntriesFromCache: vi.fn().mockResolvedValue([]),
  markPlaygroundSessionRunning: mocks.markPlaygroundSessionRunning,
  titleFromMessage: (m: string) => m,
  unbindPlaygroundSessionForReseed: vi.fn(),
}));

vi.mock("~/models/model-directive.server", () => ({
  signModelDirective: mocks.signModelDirective,
}));

vi.mock("~/models/union.server", () => ({
  findWorkspaceModel: mocks.findWorkspaceModel,
}));

vi.mock("~/seams/index.server", () => ({
  getRuntime: () => ({
    data: { projects: { findById: mocks.findById } },
    modelGateway: { checkBudget: mocks.checkBudget },
  }),
}));

const PORTAL = {
  id: "portalaaaaaa",
  projectId: "projectaaaaa",
  agentId: "agentaaaaaaa",
  slug: "slugaaaaaaaa",
  name: "Billing assistant",
  accessMode: "invite",
  modelId: null as string | null,
  effort: null as string | null,
  turnsPerHour: 20,
  monthlyTurnCap: null as number | null,
  disabledAt: null as Date | null,
};

const TARGET = {
  deploymentId: "deployaaaaaa",
  environmentId: "envaaaaaaaaa",
  releaseId: "releaseaaaaa",
  url: "http://127.0.0.1:3300",
  version: "v3",
  environmentName: "production",
  gitSha: "abc",
};

function streamRequest(fields: Record<string, string>) {
  const body = new URLSearchParams(fields);
  return new Request("https://eden.example.com/api/portal/slugaaaaaaaa/stream", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

function actionArgs(request: Request) {
  return {
    request,
    params: { slug: PORTAL.slug },
    context: { get: () => null } as never,
  };
}

async function runAction(fields: Record<string, string>) {
  const route = await import("~/routes/api.portal.$slug.stream");
  try {
    return await route.action(actionArgs(streamRequest(fields)) as never);
  } catch (thrown) {
    return thrown as Response;
  }
}

function status(result: unknown): number | null {
  if (result && typeof result === "object" && "init" in result) {
    // react-router data() throwable
    return (
      ((result as { init?: { status?: number } }).init?.status ?? null)
    );
  }
  if (result instanceof Response) return result.status;
  return null;
}

describe("portal stream action", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.getSessionAuth.mockReset().mockResolvedValue({
      user: { id: "guest-1", email: "jaden@company.com" },
    });
    mocks.getPortalBySlug.mockReset().mockResolvedValue({ ...PORTAL });
    mocks.findLiveGrant
      .mockReset()
      .mockResolvedValue({ id: "grant-1", email: "jaden@company.com" });
    mocks.portalTurnCounts
      .mockReset()
      .mockResolvedValue({ guestTurnsLastHour: 0, portalTurnsLast30d: 0 });
    mocks.recordPortalTurn.mockReset().mockResolvedValue(undefined);
    mocks.liveTargets.mockReset().mockResolvedValue([TARGET]);
    mocks.streamTurnResponse
      .mockReset()
      .mockReturnValue(new Response("stream"));
    mocks.getPlaygroundSession.mockReset().mockResolvedValue(null);
    mocks.createPlaygroundSession.mockReset().mockResolvedValue({
      id: "sessionaaaaa",
      externalSessionId: null,
      continuationToken: null,
      streamIndex: 0,
      cacheIndexOffset: 0,
      lastDeploymentId: null,
      title: null,
    });
    mocks.markPlaygroundSessionRunning.mockReset().mockResolvedValue(undefined);
    mocks.findWorkspaceModel.mockReset().mockResolvedValue(null);
    mocks.signModelDirective.mockReset().mockReturnValue("<!-- directive -->");
    mocks.findById
      .mockReset()
      .mockResolvedValue({ id: PORTAL.projectId, orgId: "org-1" });
    mocks.checkBudget.mockReset().mockResolvedValue({ allowed: true });
  });

  it("404s an unknown or disabled portal", async () => {
    mocks.getPortalBySlug.mockResolvedValue(null);
    expect(status(await runAction({ message: "hi" }))).toBe(404);

    mocks.getPortalBySlug.mockResolvedValue({
      ...PORTAL,
      disabledAt: new Date(),
    });
    expect(status(await runAction({ message: "hi" }))).toBe(404);
  });

  it("401s without a session", async () => {
    mocks.getSessionAuth.mockResolvedValue({ user: null });
    expect(status(await runAction({ message: "hi" }))).toBe(401);
  });

  it("403s a signed-in user without a live grant (revocation bites immediately)", async () => {
    mocks.findLiveGrant.mockResolvedValue(null);
    expect(status(await runAction({ message: "hi" }))).toBe(403);
    expect(mocks.streamTurnResponse).not.toHaveBeenCalled();
  });

  it("429s past the per-guest hourly rate limit, before any turn is dispatched", async () => {
    mocks.portalTurnCounts.mockResolvedValue({
      guestTurnsLastHour: 20,
      portalTurnsLast30d: 0,
    });
    expect(status(await runAction({ message: "hi" }))).toBe(429);
    expect(mocks.recordPortalTurn).not.toHaveBeenCalled();
    expect(mocks.streamTurnResponse).not.toHaveBeenCalled();
  });

  it("429s when the org budget/kill-switch disallows turns", async () => {
    mocks.checkBudget.mockResolvedValue({ allowed: false, reason: "cap" });
    expect(status(await runAction({ message: "hi" }))).toBe(429);
    expect(mocks.streamTurnResponse).not.toHaveBeenCalled();
  });

  it("409s when the agent has no live deployment", async () => {
    mocks.liveTargets.mockResolvedValue([]);
    expect(status(await runAction({ message: "hi" }))).toBe(409);
  });

  it("streams a valid turn on the portal channel and records it", async () => {
    const result = await runAction({ message: "hello there" });
    expect(result).toBeInstanceOf(Response);
    expect(mocks.recordPortalTurn).toHaveBeenCalledWith({
      portalId: PORTAL.id,
      userId: "guest-1",
    });
    expect(mocks.createPlaygroundSession).toHaveBeenCalledWith(
      expect.objectContaining({ portalId: PORTAL.id, userId: "guest-1" }),
    );
    expect(mocks.streamTurnResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "portal",
        message: "hello there",
        projectId: PORTAL.projectId,
      }),
    );
  });

  it("signs the pinned model directive when the portal pins a model", async () => {
    mocks.getPortalBySlug.mockResolvedValue({
      ...PORTAL,
      modelId: "conn/claude",
      effort: "high",
    });
    mocks.findWorkspaceModel.mockResolvedValue({ contextWindow: 200000 });
    await runAction({ message: "hello" });
    expect(mocks.signModelDirective).toHaveBeenCalledWith(
      expect.objectContaining({ id: "conn/claude", effort: "high" }),
      TARGET.deploymentId,
      expect.stringContaining("hello"),
    );
    expect(mocks.streamTurnResponse).toHaveBeenCalledWith(
      expect.objectContaining({ messagePrefix: "<!-- directive -->" }),
    );
  });

  it("falls back to the deployed default when the pinned model is unavailable", async () => {
    mocks.getPortalBySlug.mockResolvedValue({
      ...PORTAL,
      modelId: "conn/gone-model",
    });
    mocks.findWorkspaceModel.mockResolvedValue(null);
    await runAction({ message: "hello" });
    expect(mocks.signModelDirective).not.toHaveBeenCalled();
    expect(mocks.streamTurnResponse).toHaveBeenCalledWith(
      expect.objectContaining({ messagePrefix: null }),
    );
  });

  it("prefers the session's owning deployment for continuity", async () => {
    const otherTarget = { ...TARGET, deploymentId: "deploybbbbbb" };
    mocks.liveTargets.mockResolvedValue([TARGET, otherTarget]);
    mocks.getPlaygroundSession.mockResolvedValue({
      id: "sessionaaaaa",
      externalSessionId: "eve-1",
      continuationToken: null,
      streamIndex: 3,
      cacheIndexOffset: 0,
      lastDeploymentId: "deploybbbbbb",
      title: "existing",
    });
    await runAction({ message: "hello", portalSessionId: "sessionaaaaa" });
    expect(mocks.streamTurnResponse).toHaveBeenCalledWith(
      expect.objectContaining({ target: otherTarget }),
    );
  });
});
