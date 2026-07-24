/**
 * Invite-to-repo resource route (FOH invites & roles). Verifies the gate order (session →
 * requireProject, which is the BOH admin gate after D10), the action's branching (issue #221:
 * existing member → direct addTeamMember grant; pending invitation for other repos → cancel +
 * recreate with the merged team list; otherwise plain createInvitation with resend), and that
 * the loader lists only THIS team's pending invitations.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionAuth: vi.fn(),
  requireProject: vi.fn(),
  ensureProjectTeam: vi.fn(),
  addProjectTeamMember: vi.fn(),
  findOrgMemberIdByEmail: vi.fn(),
  createInvitation: vi.fn(),
  cancelInvitation: vi.fn(),
  listInvitations: vi.fn(),
  recordAudit: vi.fn(),
}));

vi.mock("~/auth/session.server", () => ({
  getSessionAuth: mocks.getSessionAuth,
  sessionLoader: async (
    _args: unknown,
    callback: (context: { auth: unknown }) => Promise<object>,
  ) => {
    const session = (await mocks.getSessionAuth(_args)) as { user: unknown };
    return { ...(await callback({ auth: session })), user: session.user };
  },
}));
vi.mock("~/project/guard.server", () => ({
  requireProject: mocks.requireProject,
}));
vi.mock("~/auth/teams.server", () => ({
  ensureProjectTeam: mocks.ensureProjectTeam,
  addProjectTeamMember: mocks.addProjectTeamMember,
  findOrgMemberIdByEmail: mocks.findOrgMemberIdByEmail,
}));
vi.mock("~/lib/auth.server", () => ({
  auth: {
    api: {
      createInvitation: mocks.createInvitation,
      cancelInvitation: mocks.cancelInvitation,
      listInvitations: mocks.listInvitations,
    },
  },
}));
vi.mock("~/managed/audit.server", () => ({ recordAudit: mocks.recordAudit }));

import { action, loader } from "~/routes/api.repos.$projectId.invite";

const PROJECT = {
  id: "proj_1",
  orgId: "org_1",
  name: "acme-repo",
  teamId: null as string | null,
};

const SESSION = {
  user: { id: "user_1", email: "owner@example.com" },
  requestHeaders: new Headers({ cookie: "s=1" }),
};

function actionArgs(form: Record<string, string>) {
  const body = new URLSearchParams(form);
  return {
    request: new Request("http://localhost/api/repos/proj_1/invite", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    }),
    params: { projectId: "proj_1" },
    context: {},
  } as never;
}

function loaderArgs() {
  return {
    request: new Request("http://localhost/api/repos/proj_1/invite"),
    params: { projectId: "proj_1" },
    context: {},
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSessionAuth.mockResolvedValue(SESSION);
  mocks.requireProject.mockResolvedValue({ ...PROJECT });
  mocks.ensureProjectTeam.mockResolvedValue("team_1");
  mocks.addProjectTeamMember.mockResolvedValue(undefined);
  mocks.findOrgMemberIdByEmail.mockResolvedValue(null);
  mocks.createInvitation.mockResolvedValue({ id: "inv_1" });
  mocks.cancelInvitation.mockResolvedValue(undefined);
  mocks.listInvitations.mockResolvedValue([]);
  mocks.recordAudit.mockResolvedValue(undefined);
});

describe("invite action", () => {
  it("ensures the repo team and threads its id into createInvitation", async () => {
    const result = await action(
      actionArgs({ intent: "invite", email: "Teammate@Example.com" }),
    );

    expect(mocks.requireProject).toHaveBeenCalledWith(SESSION, "proj_1");
    expect(mocks.ensureProjectTeam).toHaveBeenCalledWith("org_1", {
      ...PROJECT,
    });
    expect(mocks.createInvitation).toHaveBeenCalledWith({
      body: {
        email: "teammate@example.com",
        role: "member",
        organizationId: "org_1",
        teamId: "team_1",
        resend: true,
      },
      headers: SESSION.requestHeaders,
    });
    expect(mocks.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org_1",
        actorUserId: "user_1",
        action: "member_invited",
        target: "teammate@example.com",
        meta: { projectId: "proj_1", teamId: "team_1" },
      }),
    );
    expect(result).toEqual({ ok: true });
  });

  it("grants an existing org member directly instead of inviting", async () => {
    mocks.findOrgMemberIdByEmail.mockResolvedValue("user_9");

    const result = await action(
      actionArgs({ intent: "invite", email: "Member@Example.com" }),
    );

    expect(mocks.findOrgMemberIdByEmail).toHaveBeenCalledWith(
      "org_1",
      "member@example.com",
    );
    expect(mocks.addProjectTeamMember).toHaveBeenCalledWith({
      orgId: "org_1",
      teamId: "team_1",
      userId: "user_9",
      headers: SESSION.requestHeaders,
    });
    expect(mocks.createInvitation).not.toHaveBeenCalled();
    expect(mocks.cancelInvitation).not.toHaveBeenCalled();
    expect(mocks.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "member_granted_repo",
        target: "member@example.com",
        meta: { projectId: "proj_1", teamId: "team_1" },
      }),
    );
    expect(result).toEqual({ ok: true });
  });

  it("maps a direct-grant failure to a sanitized error without auditing", async () => {
    mocks.findOrgMemberIdByEmail.mockResolvedValue("user_9");
    mocks.addProjectTeamMember.mockRejectedValue(new Error("adapter down"));

    const result = await action(
      actionArgs({ intent: "invite", email: "member@example.com" }),
    );

    expect(result).toEqual({
      error: "Could not grant this member access to the repository.",
    });
    expect(mocks.recordAudit).not.toHaveBeenCalled();
  });

  it("merges a pending invitation for other repos: cancel, then recreate with both teams", async () => {
    mocks.listInvitations.mockResolvedValue([
      {
        id: "inv_old",
        email: "Pending@Example.com",
        status: "pending",
        role: "member",
        teamId: "team_a,team_b",
        expiresAt: new Date("2026-08-01T00:00:00Z"),
      },
    ]);

    const result = await action(
      actionArgs({ intent: "invite", email: "pending@example.com" }),
    );

    expect(mocks.cancelInvitation).toHaveBeenCalledWith({
      body: { invitationId: "inv_old" },
      headers: SESSION.requestHeaders,
    });
    expect(mocks.createInvitation).toHaveBeenCalledWith({
      body: {
        email: "pending@example.com",
        role: "member",
        organizationId: "org_1",
        teamId: ["team_a", "team_b", "team_1"],
      },
      headers: SESSION.requestHeaders,
    });
    expect(mocks.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "member_invited",
        target: "pending@example.com",
      }),
    );
    expect(result).toEqual({ ok: true });
  });

  it("resends unchanged when the pending invitation already targets this repo", async () => {
    mocks.listInvitations.mockResolvedValue([
      {
        id: "inv_same",
        email: "pending@example.com",
        status: "pending",
        role: "member",
        teamId: "team_0,team_1",
        expiresAt: new Date("2026-08-01T00:00:00Z"),
      },
    ]);

    const result = await action(
      actionArgs({ intent: "invite", email: "pending@example.com" }),
    );

    expect(mocks.cancelInvitation).not.toHaveBeenCalled();
    expect(mocks.createInvitation).toHaveBeenCalledWith({
      body: {
        email: "pending@example.com",
        role: "member",
        organizationId: "org_1",
        teamId: "team_1",
        resend: true,
      },
      headers: SESSION.requestHeaders,
    });
    expect(result).toEqual({ ok: true });
  });

  it("ignores accepted/canceled invitations when looking for a pending one", async () => {
    mocks.listInvitations.mockResolvedValue([
      {
        id: "inv_done",
        email: "fresh@example.com",
        status: "accepted",
        role: "member",
        teamId: "team_9",
        expiresAt: new Date("2026-08-01T00:00:00Z"),
      },
    ]);

    await action(actionArgs({ intent: "invite", email: "fresh@example.com" }));

    expect(mocks.cancelInvitation).not.toHaveBeenCalled();
    expect(mocks.createInvitation).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ teamId: "team_1", resend: true }),
      }),
    );
  });

  it("propagates requireProject's rejection of a front-of-house member", async () => {
    // After D10 requireProject throws 403 for member-role callers on API routes.
    const denial = { data: { error: "denied" }, init: { status: 403 } };
    mocks.requireProject.mockRejectedValue(denial);

    await expect(
      action(actionArgs({ intent: "invite", email: "x@example.com" })),
    ).rejects.toBe(denial);
    expect(mocks.ensureProjectTeam).not.toHaveBeenCalled();
    expect(mocks.createInvitation).not.toHaveBeenCalled();
  });

  it("rejects malformed email without touching Better Auth", async () => {
    const result = await action(actionArgs({ intent: "invite", email: "nope" }));
    expect(result).toEqual({ error: "Enter a valid email address." });
    expect(mocks.ensureProjectTeam).not.toHaveBeenCalled();
    expect(mocks.createInvitation).not.toHaveBeenCalled();
  });

  it("reports a sanitized error when the team cannot be ensured", async () => {
    mocks.ensureProjectTeam.mockRejectedValue(new Error("db down"));
    const result = await action(
      actionArgs({ intent: "invite", email: "x@example.com" }),
    );
    expect(result).toEqual({
      error: "Could not prepare this repository's team.",
    });
    expect(mocks.createInvitation).not.toHaveBeenCalled();
  });

  it("returns an error for unknown intents", async () => {
    const result = await action(actionArgs({ intent: "cancel" }));
    expect(result).toEqual({ error: "Unknown action." });
    expect(mocks.createInvitation).not.toHaveBeenCalled();
  });
});

describe("invite loader", () => {
  it("returns an empty list without calling Better Auth when the repo has no team yet", async () => {
    const result = await loader(loaderArgs());
    expect(result).toMatchObject({ invites: [] });
    expect(mocks.listInvitations).not.toHaveBeenCalled();
  });

  it("lists only this team's pending invitations", async () => {
    mocks.requireProject.mockResolvedValue({ ...PROJECT, teamId: "team_1" });
    const expiresAt = new Date("2026-08-01T00:00:00Z");
    mocks.listInvitations.mockResolvedValue([
      {
        id: "inv_pending",
        email: "a@example.com",
        status: "pending",
        teamId: "team_1",
        expiresAt,
      },
      // Multi-team invitations are stored comma-separated by Better Auth.
      {
        id: "inv_multi",
        email: "b@example.com",
        status: "pending",
        teamId: "team_0,team_1",
        expiresAt,
      },
      {
        id: "inv_other_team",
        email: "c@example.com",
        status: "pending",
        teamId: "team_9",
        expiresAt,
      },
      {
        id: "inv_org_wide",
        email: "d@example.com",
        status: "pending",
        teamId: null,
        expiresAt,
      },
      {
        id: "inv_accepted",
        email: "e@example.com",
        status: "accepted",
        teamId: "team_1",
        expiresAt,
      },
    ]);

    const result = await loader(loaderArgs());
    expect(result).toMatchObject({
      invites: [
        {
          id: "inv_pending",
          email: "a@example.com",
          expiresAt: expiresAt.toISOString(),
        },
        {
          id: "inv_multi",
          email: "b@example.com",
          expiresAt: expiresAt.toISOString(),
        },
      ],
    });
  });
});
