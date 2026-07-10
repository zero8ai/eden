import { RouterContextProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";

const getSession = vi.hoisted(() => vi.fn());

vi.mock("~/lib/auth.server", () => ({
  auth: { api: { getSession } },
}));

describe("explicit authentication return destinations", () => {
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
});
