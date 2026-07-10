import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  getInvitation: vi.fn(),
  handler: vi.fn(),
}));

vi.mock("~/auth/session.server", () => ({
  requireSession: mocks.requireSession,
  sessionLoader: vi.fn(),
}));

vi.mock("~/lib/auth.server", () => ({
  auth: {
    api: { getInvitation: mocks.getInvitation },
    handler: mocks.handler,
  },
}));

const EMAIL = "invitee@example.com";
const INVITATION_ID = "invitation-123";

function verificationRequest() {
  return new Request(
    `https://eden.example.com/accept-invitation/${INVITATION_ID}`,
    {
      method: "POST",
      headers: {
        cookie: "better-auth.session_token=test-cookie",
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://eden.example.com",
        "x-real-ip": "203.0.113.10",
      },
      body: new URLSearchParams({
        intent: "send-verification",
        invitationId: INVITATION_ID,
      }),
    },
  );
}

function actionArgs(request: Request) {
  return {
    request,
    url: new URL(request.url),
    pattern: "/accept-invitation/:invitationId",
    params: { invitationId: INVITATION_ID },
    context: {} as never,
  };
}

describe("invitation verification route", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.requireSession.mockReset().mockResolvedValue({
      user: { email: EMAIL },
      requestHeaders: new Headers(),
    });
    mocks.getInvitation.mockReset().mockRejectedValue({
      body: { code: "EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION" },
    });
    mocks.handler.mockReset();
  });

  it("sends through Better Auth's rate-limited handler endpoint", async () => {
    mocks.handler.mockResolvedValue(
      Response.json({ status: true }, { status: 200 }),
    );
    const { action } = await import("~/routes/accept-invitation.$invitationId");

    await expect(action(actionArgs(verificationRequest()))).resolves.toEqual({
      verificationSent: true,
    });
    expect(mocks.handler).toHaveBeenCalledOnce();

    const forwarded = mocks.handler.mock.calls[0][0] as Request;
    expect(forwarded.method).toBe("POST");
    expect(forwarded.url).toBe(
      "https://eden.example.com/api/auth/send-verification-email",
    );
    expect(forwarded.headers.get("content-type")).toBe("application/json");
    expect(forwarded.headers.get("origin")).toBe("https://eden.example.com");
    expect(forwarded.headers.get("cookie")).toBe(
      "better-auth.session_token=test-cookie",
    );
    expect(forwarded.headers.get("x-real-ip")).toBe("203.0.113.10");
    await expect(forwarded.json()).resolves.toEqual({
      email: EMAIL,
      callbackURL: `https://eden.example.com/accept-invitation/${INVITATION_ID}`,
    });
  });

  it("surfaces Better Auth's endpoint throttle without sending again", async () => {
    mocks.handler.mockResolvedValue(
      Response.json(
        { message: "Too many requests. Please try again later." },
        { status: 429 },
      ),
    );
    const { action } = await import("~/routes/accept-invitation.$invitationId");

    await expect(action(actionArgs(verificationRequest()))).resolves.toEqual({
      error:
        "Too many verification emails. Please wait a minute and try again.",
    });
    expect(mocks.handler).toHaveBeenCalledOnce();
  });

  it("does not expose an unexpected handler error", async () => {
    mocks.handler.mockRejectedValue(
      new Error("select token from verification where secret = $1"),
    );
    const { action } = await import("~/routes/accept-invitation.$invitationId");

    await expect(action(actionArgs(verificationRequest()))).resolves.toEqual({
      error: "Could not send the verification email.",
    });
  });
});
