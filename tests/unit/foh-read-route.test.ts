/**
 * FOH read-acknowledgement route (app/routes/api.foh.read.ts): the D3/D13 read mark is an
 * explicit POST — never a side effect of the prefetchable session GET loader (issue #221
 * finding 8). Guards mirror the stop route: auth → FOH scope → viewer-visible session.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionAuth: vi.fn(),
  requireFohProject: vi.fn(),
  getFohSessionForViewer: vi.fn(),
  markSessionRead: vi.fn(async () => {}),
}));

vi.mock("~/auth/session.server", () => ({
  getSessionAuth: mocks.getSessionAuth,
}));
vi.mock("~/foh/guard.server", () => ({
  requireFohProject: mocks.requireFohProject,
}));
vi.mock("~/playground/sessions.server", () => ({
  getFohSessionForViewer: mocks.getFohSessionForViewer,
}));
vi.mock("~/foh/reads.server", () => ({
  markSessionRead: mocks.markSessionRead,
}));
vi.mock("~/chat/turn-stream.server", () => ({
  asString: (value: FormDataEntryValue | null) =>
    typeof value === "string" ? value : "",
}));

import { action } from "~/routes/api.foh.read";

function actionArgs(form: Record<string, string>) {
  const body = new URLSearchParams(form);
  return {
    request: new Request("http://localhost/api/foh/proj_1/read", {
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
  mocks.getSessionAuth.mockResolvedValue({ user: { id: "user_1" } });
  mocks.requireFohProject.mockResolvedValue({
    project: { id: "proj_1" },
    backOfHouse: false,
  });
});

describe("POST /api/foh/:projectId/read", () => {
  it("marks a viewer-visible session read", async () => {
    const session = { id: "sess_1", lastEventAt: new Date() };
    mocks.getFohSessionForViewer.mockResolvedValue(session);
    const result = await action(actionArgs({ playgroundSessionId: "sess_1" }));
    expect(result).toEqual({ ok: true });
    expect(mocks.markSessionRead).toHaveBeenCalledWith(session, "user_1");
    expect(mocks.getFohSessionForViewer).toHaveBeenCalledWith({
      id: "sess_1",
      projectId: "proj_1",
      viewerId: "user_1",
      includeAll: false,
    });
  });

  it("404s for a session outside the viewer's scope", async () => {
    mocks.getFohSessionForViewer.mockResolvedValue(null);
    await expect(
      action(actionArgs({ playgroundSessionId: "sess_hidden" })),
    ).rejects.toMatchObject({ init: { status: 404 } });
    expect(mocks.markSessionRead).not.toHaveBeenCalled();
  });

  it("400s without a session id", async () => {
    await expect(action(actionArgs({}))).rejects.toMatchObject({
      init: { status: 400 },
    });
    expect(mocks.markSessionRead).not.toHaveBeenCalled();
  });
});
