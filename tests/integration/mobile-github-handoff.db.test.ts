/** Real-Postgres proof that native GitHub handoffs are binding-aware and atomically single-use. */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

const LIVE = process.env.EDEN_DB_SMOKE === "1";
const ORIGIN = "http://localhost:5276";

process.env.BETTER_AUTH_SECRET ??=
  "eden-mobile-github-handoff-integration-secret-at-least-32-characters";
process.env.BETTER_AUTH_URL ??= ORIGIN;

function signupRequest(email: string): Request {
  return new Request(`${ORIGIN}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({
      name: "Mobile GitHub Handoff Smoke",
      email,
      password: "correct-horse-battery-staple",
    }),
  });
}

function sessionCookie(response: Response): string {
  const header = response.headers.get("set-cookie");
  if (!header) throw new Error("Better Auth did not set a session cookie.");
  return header.split(";", 1)[0];
}

describe.runIf(LIVE)("mobile GitHub handoffs against real Postgres", () => {
  it("rejects wrong bindings and expiry, then permits exactly one atomic redeemer", async () => {
    const { auth } = await import("~/lib/auth.server");
    const { db } = await import("~/db/client.server");
    const { organization, user } = await import("~/db/auth-schema");
    const { consumeMobileGithubHandoff, createMobileGithubHandoff } =
      await import("~/github/mobile-install.server");

    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let userId: string | undefined;
    let orgId: string | undefined;

    try {
      const signup = await auth.handler(
        signupRequest(`mobile-github-handoff-${suffix}@smoke.test`),
      );
      expect(signup.status).toBe(200);
      const headers = new Headers({ cookie: sessionCookie(signup) });
      const signedIn = await auth.api.getSession({ headers });
      expect(signedIn).toBeTruthy();
      userId = signedIn!.user.id;

      const created = await auth.api.createOrganization({
        headers,
        body: {
          name: "Mobile GitHub Handoff Smoke",
          slug: `mobile-github-handoff-${suffix}`,
        },
      });
      expect(created).toBeTruthy();
      orgId = created!.id;

      const binding = {
        orgId,
        userId,
        sessionId: signedIn!.session.id,
      };
      const code = await createMobileGithubHandoff({
        ...binding,
        installationId: "4242",
        expiresAt: new Date(Date.now() + 60_000),
      });

      await expect(
        consumeMobileGithubHandoff({
          code,
          ...binding,
          userId: "another-user",
        }),
      ).resolves.toBeNull();
      await expect(
        consumeMobileGithubHandoff({
          code,
          ...binding,
          sessionId: "another-session",
        }),
      ).resolves.toBeNull();
      await expect(
        consumeMobileGithubHandoff({
          code,
          ...binding,
          orgId: "another-org",
        }),
      ).resolves.toBeNull();
      await expect(
        consumeMobileGithubHandoff({ code, ...binding }),
      ).resolves.toBe("4242");
      await expect(
        consumeMobileGithubHandoff({ code, ...binding }),
      ).resolves.toBeNull();

      const expired = await createMobileGithubHandoff({
        ...binding,
        installationId: "4242",
        expiresAt: new Date(Date.now() - 1),
      });
      await expect(
        consumeMobileGithubHandoff({ code: expired, ...binding }),
      ).resolves.toBeNull();

      const raced = await createMobileGithubHandoff({
        ...binding,
        installationId: "4242",
        expiresAt: new Date(Date.now() + 60_000),
      });
      const winners = await Promise.all([
        consumeMobileGithubHandoff({ code: raced, ...binding }),
        consumeMobileGithubHandoff({ code: raced, ...binding }),
      ]);
      expect(winners.filter((value) => value === "4242")).toHaveLength(1);
      expect(winners.filter((value) => value === null)).toHaveLength(1);
    } finally {
      if (orgId) {
        await db.delete(organization).where(eq(organization.id, orgId));
      }
      if (userId) await db.delete(user).where(eq(user.id, userId));
    }
  });
});
