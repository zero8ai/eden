import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getSession = vi.hoisted(() => vi.fn());

vi.mock("~/lib/auth.server", () => ({
  auth: { api: { getSession } },
}));

const KEY = "1f8b16e6a46dd3ac12ef7a328f1ce35c67b5bc8f1acdd76280e3674c3a4f19b2";

function middlewareArgs(request: Request, context: RouterContextProvider) {
  const url = new URL(request.url);
  return {
    request,
    context,
    url,
    pattern: url.pathname,
    params: {},
  };
}

function setCookies(response: Response): string[] {
  return typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : response.headers.get("set-cookie")
      ? [response.headers.get("set-cookie")!]
      : [];
}

describe("explicit authentication return destinations", () => {
  beforeEach(() => {
    getSession.mockReset();
    process.env.EDEN_SECRETS_KEY = KEY;
    process.env.BETTER_AUTH_URL = "https://eden.example.com";
  });

  it("does not copy callback credentials into the login URL", async () => {
    getSession.mockResolvedValue({ response: null, headers: new Headers() });
    const { sessionLoader } = await import("~/auth/session.server");
    const request = new Request(
      "https://eden.example.com/google/callback?code=one-time-code&state=signed-state",
    );

    let response: Response | undefined;
    try {
      await sessionLoader(
        { request, context: new RouterContextProvider() },
        async () => ({ ok: true }),
        { ensureSignedIn: true, returnTo: "/dashboard" },
      );
    } catch (error) {
      if (error instanceof Response) response = error;
      else throw error;
    }

    expect(response?.status).toBe(302);
    expect(response?.headers.get("location")).toBe(
      "/login?returnTo=%2Fdashboard",
    );
    expect(response?.headers.get("location")).not.toContain("one-time-code");
    expect(response?.headers.get("location")).not.toContain("signed-state");
  });

  it("scrubs a Google callback before session I/O, then clears staging on the clean hop", async () => {
    const { betterAuthSessionMiddleware, getSessionAuth } =
      await import("~/auth/session.server");
    const { stageGoogleCallback } =
      await import("~/connections/google-callback.server");
    const sensitiveRequest = new Request(
      "https://eden.example.com/google/callback?code=raw-code&state=raw-state",
    );
    const sensitiveContext = new RouterContextProvider();

    const staged = await betterAuthSessionMiddleware(
      middlewareArgs(sensitiveRequest, sensitiveContext),
      async () => {
        const session = await getSessionAuth({
          request: sensitiveRequest,
          context: sensitiveContext,
        });
        expect(session.user).toBeNull();
        return stageGoogleCallback(sensitiveRequest);
      },
    );
    expect(staged).toBeInstanceOf(Response);
    if (!(staged instanceof Response)) {
      throw new Error("Session middleware did not return the staged response.");
    }
    expect(getSession).not.toHaveBeenCalled();
    expect(staged.status).toBe(302);
    expect(staged.headers.get("location")).toBe("/google/callback");
    expect(staged.headers.get("cache-control")).toBe("private, no-store");
    expect(staged.headers.get("referrer-policy")).toBe("no-referrer");
    const stagingCookie = setCookies(staged).find((value) =>
      value.startsWith("eden-google-oauth-callback="),
    );
    expect(stagingCookie).toBeTruthy();
    expect(stagingCookie).not.toContain("raw-code");
    expect(stagingCookie).not.toContain("raw-state");

    getSession.mockResolvedValue({
      response: null,
      headers: new Headers(),
    });
    const cleanRequest = new Request(
      "https://eden.example.com/google/callback",
      { headers: { cookie: stagingCookie!.split(";", 1)[0] } },
    );
    const clean = await betterAuthSessionMiddleware(
      middlewareArgs(cleanRequest, new RouterContextProvider()),
      async () => new Response("clean callback"),
    );
    expect(clean).toBeInstanceOf(Response);
    if (!(clean instanceof Response)) {
      throw new Error("Session middleware did not return the clean response.");
    }
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(
      setCookies(clean).some(
        (value) =>
          value.startsWith("eden-google-oauth-callback=") &&
          value.includes("Max-Age=0"),
      ),
    ).toBe(true);
  });
});
