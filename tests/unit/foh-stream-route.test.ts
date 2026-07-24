/**
 * FOH streaming route (app/routes/api.foh.stream.ts) — gate order and the FOH-specific
 * behaviors, with every collaborator mocked: auth → FOH scope guard → agent tenancy →
 * target/wake → supersede (beginFohTurn) → create-or-continue → streamTurnResponse with
 * channel "foh". Replaces the deleted portal-stream-route coverage as the "new surface over
 * the shared drain" proof.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionAuth: vi.fn(),
  requireFohProject: vi.fn(),
  liveTargets: vi.fn(),
  ensureLiveDeploymentForEnvironment: vi.fn(),
  listAgentEnvironments: vi.fn(),
  beginFohTurn: vi.fn(async () => {}),
  getFohSessionForViewer: vi.fn(),
  createPlaygroundSession: vi.fn(),
  setPlaygroundSessionModel: vi.fn(async () => true),
  markPlaygroundSessionRunning: vi.fn(async () => {}),
  unbindPlaygroundSessionForReseed: vi.fn(),
  loadPlaygroundEntriesFromCache: vi.fn(async () => []),
  streamTurnResponse: vi.fn(() => new Response("ok")),
  findWorkspaceModel: vi.fn(async () => null),
  ownsWorkspaceModelReference: vi.fn(async () => true),
  signModelDirective: vi.fn(() => "[directive]"),
  agentsFindById: vi.fn(),
}));

vi.mock("~/auth/session.server", () => ({
  getSessionAuth: mocks.getSessionAuth,
}));
vi.mock("~/foh/guard.server", () => ({
  requireFohProject: mocks.requireFohProject,
}));
vi.mock("~/chat/playground.server", () => ({
  liveTargets: mocks.liveTargets,
}));
vi.mock("~/deploy/wake.server", () => ({
  ensureLiveDeploymentForEnvironment: mocks.ensureLiveDeploymentForEnvironment,
}));
vi.mock("~/db/queries.server", () => ({
  listAgentEnvironments: mocks.listAgentEnvironments,
}));
vi.mock("~/foh/inbox.server", () => ({
  beginFohTurn: mocks.beginFohTurn,
}));
vi.mock("~/playground/sessions.server", () => ({
  getFohSessionForViewer: mocks.getFohSessionForViewer,
  createPlaygroundSession: mocks.createPlaygroundSession,
  setPlaygroundSessionModel: mocks.setPlaygroundSessionModel,
  markPlaygroundSessionRunning: mocks.markPlaygroundSessionRunning,
  unbindPlaygroundSessionForReseed: mocks.unbindPlaygroundSessionForReseed,
  loadPlaygroundEntriesFromCache: mocks.loadPlaygroundEntriesFromCache,
  titleFromMessage: (message: string) => message.slice(0, 80),
}));
vi.mock("~/chat/turn-stream.server", () => ({
  streamTurnResponse: mocks.streamTurnResponse,
  asString: (value: FormDataEntryValue | null) =>
    typeof value === "string" ? value : "",
}));
vi.mock("~/models/union.server", () => ({
  findWorkspaceModel: mocks.findWorkspaceModel,
  ownsWorkspaceModelReference: mocks.ownsWorkspaceModelReference,
}));
vi.mock("~/models/model-directive.server", () => ({
  signModelDirective: mocks.signModelDirective,
}));
vi.mock("~/seams/index.server", () => ({
  getRuntime: () => ({ data: { agents: { findById: mocks.agentsFindById } } }),
}));

import { action } from "~/routes/api.foh.stream";

const AUTH = { user: { id: "user_1" } };
const PROJECT = { id: "proj_1", orgId: "org_1", name: "repo" };
const AGENT = { id: "agent_1", projectId: "proj_1", name: "ivy", kind: "member" };
const TARGET = {
  deploymentId: "dep_1",
  environmentId: "env_1",
  releaseId: "rel_1",
  url: "http://inst",
  version: "v1",
  environmentName: "production",
  gitSha: "abc",
};

function sessionRow(over: Record<string, unknown> = {}) {
  return {
    id: "ps_1",
    projectId: "proj_1",
    agentId: "agent_1",
    createdBy: "user_1",
    surface: "foh",
    environmentId: "env_1",
    externalSessionId: "eve_1",
    lastDeploymentId: "dep_1",
    continuationToken: "tok",
    streamIndex: 4,
    status: "waiting",
    title: "Fix the 404",
    modelId: null,
    effort: null,
    pendingInputAt: null,
    ...over,
  };
}

function args(form: Record<string, string>) {
  const body = new URLSearchParams(form);
  return {
    request: new Request("http://localhost/api/foh/proj_1/stream", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    }),
    params: { projectId: "proj_1" },
    context: {},
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSessionAuth.mockResolvedValue(AUTH);
  mocks.requireFohProject.mockResolvedValue({
    project: PROJECT,
    active: { org: { id: "org_1" }, member: { role: "owner" } },
    backOfHouse: true,
  });
  mocks.agentsFindById.mockResolvedValue(AGENT);
  mocks.liveTargets.mockResolvedValue([TARGET]);
  mocks.getFohSessionForViewer.mockResolvedValue(sessionRow());
  mocks.createPlaygroundSession.mockResolvedValue(sessionRow({ id: "ps_new" }));
  mocks.streamTurnResponse.mockReturnValue(new Response("ok"));
});

describe("FOH stream route", () => {
  it("continues an existing session: guard → supersede → run with channel foh", async () => {
    const res = await action(
      args({ agentId: "agent_1", playgroundSessionId: "ps_1", message: "go" }),
    );
    expect(res).toBeInstanceOf(Response);

    expect(mocks.requireFohProject).toHaveBeenCalledWith(AUTH, "proj_1");
    expect(mocks.getFohSessionForViewer).toHaveBeenCalledWith({
      id: "ps_1",
      projectId: "proj_1",
      agentId: "agent_1",
      viewerId: "user_1",
      includeAll: true,
    });
    // Supersede (D13) runs before the turn, never a create.
    expect(mocks.beginFohTurn).toHaveBeenCalledWith("ps_1");
    expect(mocks.createPlaygroundSession).not.toHaveBeenCalled();
    expect(mocks.markPlaygroundSessionRunning).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ps_1" }),
    );
    expect(mocks.streamTurnResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "foh",
        projectId: "proj_1",
        message: "go",
        target: TARGET,
      }),
    );
    // Guard precedes work: no wake needed with a live target.
    expect(mocks.ensureLiveDeploymentForEnvironment).not.toHaveBeenCalled();
  });

  it("creates the FOH session (surface foh, auto-title) when none is passed", async () => {
    await action(args({ agentId: "agent_1", message: "Fix the portal 404" }));
    expect(mocks.createPlaygroundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj_1",
        agentId: "agent_1",
        userId: "user_1",
        surface: "foh",
        title: "Fix the portal 404",
      }),
    );
    // A brand-new session has nothing to supersede.
    expect(mocks.beginFohTurn).not.toHaveBeenCalled();
  });

  it("wakes a stopped agent before the turn (session env first) and proceeds", async () => {
    mocks.liveTargets
      .mockResolvedValueOnce([]) // before the wake
      .mockResolvedValueOnce([TARGET]); // after the wake
    mocks.listAgentEnvironments.mockResolvedValue([
      { id: "env_other" },
      { id: "env_1" },
    ]);
    mocks.ensureLiveDeploymentForEnvironment.mockResolvedValue({ id: "dep_1" });

    await action(
      args({ agentId: "agent_1", playgroundSessionId: "ps_1", message: "go" }),
    );
    // The parked session's own environment is tried first.
    expect(mocks.ensureLiveDeploymentForEnvironment).toHaveBeenCalledWith("env_1");
    expect(mocks.streamTurnResponse).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "foh", target: TARGET }),
    );
  });

  it("rejects with a clean error when nothing is live and nothing wakes", async () => {
    mocks.liveTargets.mockResolvedValue([]);
    mocks.listAgentEnvironments.mockResolvedValue([{ id: "env_1" }]);
    mocks.ensureLiveDeploymentForEnvironment.mockResolvedValue(null);

    await expect(
      action(args({ agentId: "agent_1", message: "go" })),
    ).rejects.toMatchObject({ init: { status: 400 } });
    expect(mocks.streamTurnResponse).not.toHaveBeenCalled();
  });

  it("propagates the FOH scope guard before any work", async () => {
    mocks.requireFohProject.mockRejectedValue(
      Object.assign(new Error("nope"), { status: 404 }),
    );
    await expect(
      action(args({ agentId: "agent_1", message: "go" })),
    ).rejects.toMatchObject({ status: 404 });
    expect(mocks.liveTargets).not.toHaveBeenCalled();
    expect(mocks.streamTurnResponse).not.toHaveBeenCalled();
  });

  it("404s a session outside the viewer's scope (builder surfaces invisible by query)", async () => {
    mocks.getFohSessionForViewer.mockResolvedValue(null);
    await expect(
      action(
        args({ agentId: "agent_1", playgroundSessionId: "ps_hidden", message: "go" }),
      ),
    ).rejects.toMatchObject({ init: { status: 404 } });
    expect(mocks.beginFohTurn).not.toHaveBeenCalled();
    expect(mocks.streamTurnResponse).not.toHaveBeenCalled();
  });

  it("404s an agent from another project", async () => {
    mocks.agentsFindById.mockResolvedValue({ ...AGENT, projectId: "proj_2" });
    await expect(
      action(args({ agentId: "agent_1", message: "go" })),
    ).rejects.toMatchObject({ init: { status: 404 } });
  });
});
