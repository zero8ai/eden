/**
 * Share resource route (issue #180): the endpoint behind the agent "Share" dialog. These tests
 * pin the invite path (validate email → auto-provision the agent's portal → grant → magic-link
 * send with the portal's callbackURL), the revoke path, and that a bad email never grants access.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionAuth: vi.fn(),
  requireProject: vi.fn(),
  requireRepo: vi.fn((p: unknown) => p),
  resolveAgentContext: vi.fn(),
  findAgentPortal: vi.fn(),
  getOrCreatePortalForAgent: vi.fn(),
  listGrants: vi.fn(),
  upsertGrant: vi.fn(),
  revokeGrant: vi.fn(),
  signInMagicLink: vi.fn(),
}));

vi.mock("~/auth/session.server", () => ({
  getSessionAuth: mocks.getSessionAuth,
}));

vi.mock("~/project/guard.server", () => ({
  requireProject: mocks.requireProject,
  requireRepo: mocks.requireRepo,
}));

vi.mock("~/project/agent-context.server", () => ({
  resolveAgentContext: mocks.resolveAgentContext,
}));

vi.mock("~/portal/portals.server", () => ({
  findAgentPortal: mocks.findAgentPortal,
  getOrCreatePortalForAgent: mocks.getOrCreatePortalForAgent,
  listGrants: mocks.listGrants,
  upsertGrant: mocks.upsertGrant,
  revokeGrant: mocks.revokeGrant,
}));

vi.mock("~/lib/auth.server", () => ({
  auth: { api: { signInMagicLink: mocks.signInMagicLink } },
}));

import { action, loader } from "~/routes/api.repos.$projectId.share";

const AGENT = { id: "agent-1", name: "Support", root: "." };
const PORTAL = { id: "portal-1", slug: "abc123", name: "Support" };

function postArgs(fields: Record<string, string>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return {
    request: new Request("http://localhost/api/repos/proj-1/share", {
      method: "POST",
      body: form,
    }),
    params: { projectId: "proj-1" },
    context: {},
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSessionAuth.mockResolvedValue({ user: { id: "user-1" } });
  mocks.requireProject.mockResolvedValue({ id: "proj-1", name: "Repo" });
  mocks.requireRepo.mockImplementation((p: unknown) => p);
  mocks.resolveAgentContext.mockResolvedValue({ roster: [AGENT] });
  mocks.getOrCreatePortalForAgent.mockResolvedValue(PORTAL);
  mocks.findAgentPortal.mockResolvedValue(PORTAL);
  mocks.upsertGrant.mockResolvedValue({ id: "grant-1" });
  mocks.signInMagicLink.mockResolvedValue({ status: true });
});

describe("share route — invite", () => {
  it("grants the email and sends a magic link with the portal's callbackURL", async () => {
    const result = await action(postArgs({ intent: "invite", email: "guest@co.com" }));

    expect(mocks.upsertGrant).toHaveBeenCalledWith({
      portalId: PORTAL.id,
      email: "guest@co.com",
      invitedBy: "user-1",
    });
    expect(mocks.signInMagicLink).toHaveBeenCalledTimes(1);
    const call = mocks.signInMagicLink.mock.calls[0][0];
    expect(call.body).toEqual({
      email: "guest@co.com",
      callbackURL: "/a/abc123",
    });
    expect(result).toEqual({ ok: true });
  });

  it("normalises the email before granting", async () => {
    await action(postArgs({ intent: "invite", email: "  Guest@CO.com " }));
    expect(mocks.upsertGrant).toHaveBeenCalledWith(
      expect.objectContaining({ email: "guest@co.com" }),
    );
  });

  it("rejects an invalid email without granting or emailing", async () => {
    const result = await action(postArgs({ intent: "invite", email: "not-an-email" }));
    expect(result).toEqual({ error: "Enter a valid email address." });
    expect(mocks.upsertGrant).not.toHaveBeenCalled();
    expect(mocks.signInMagicLink).not.toHaveBeenCalled();
  });

  it("still reports access granted when the email send fails", async () => {
    mocks.signInMagicLink.mockRejectedValueOnce(new Error("smtp down"));
    const result = await action(postArgs({ intent: "invite", email: "guest@co.com" }));
    expect(mocks.upsertGrant).toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, warning: expect.any(String) });
  });
});

describe("share route — revoke", () => {
  it("revokes the grant against the agent's own portal", async () => {
    const result = await action(
      postArgs({ intent: "revoke", grantId: "grant-9" }),
    );
    expect(mocks.revokeGrant).toHaveBeenCalledWith({
      portalId: PORTAL.id,
      grantId: "grant-9",
    });
    expect(result).toEqual({ ok: true });
  });
});

describe("share route — loader", () => {
  it("returns the live access list for the agent", async () => {
    mocks.listGrants.mockResolvedValue([
      { id: "g1", email: "a@co.com", revokedAt: null },
      { id: "g2", email: "b@co.com", revokedAt: new Date() },
    ]);
    const result = (await loader({
      request: new Request(
        "http://localhost/api/repos/proj-1/share?agentName=Support",
      ),
      params: { projectId: "proj-1" },
      context: {},
    } as never)) as {
      agentName: string;
      portalSlug: string | null;
      people: { id: string; email: string }[];
    };
    expect(result.agentName).toBe("Support");
    expect(result.portalSlug).toBe("abc123");
    // Revoked grants are filtered out of the visible list.
    expect(result.people).toEqual([{ id: "g1", email: "a@co.com" }]);
  });
});
