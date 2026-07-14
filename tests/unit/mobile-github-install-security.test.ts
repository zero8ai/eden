/** Security invariants for the browser-to-native GitHub App installation handoff (issue #152). */
import { randomBytes } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  githubUserCanAccessInstallation,
  mobileGithubHandoffUrl,
  signMobileGithubState,
  toMobileGithubVerifyState,
  validateMobileGithubRedirectUrl,
  verifyMobileGithubState,
  type MobileGithubSetupState,
} from "~/github/mobile-install.server";
import { githubInstallAuthOutcome } from "../../mobile/src/lib/github-install-auth";

const setupState: MobileGithubSetupState = {
  provider: "github-mobile-install",
  phase: "setup",
  orgId: "org-owner",
  userId: "user-owner",
  sessionId: "session-owner",
  nonce: "nonce-owner",
  redirectUrl: "eden://connect",
  exp: 1_800_000_000_000,
};

describe("mobile GitHub installation state", () => {
  const key = randomBytes(32);

  it("round-trips a signed setup state and upgrades only a numeric installation id", () => {
    const token = signMobileGithubState(setupState, key);
    const verified = verifyMobileGithubState(token, key, setupState.exp - 1);

    expect(verified).toEqual(setupState);
    expect(toMobileGithubVerifyState(setupState, "4242")).toEqual({
      ...setupState,
      phase: "verify",
      installationId: "4242",
    });
    expect(toMobileGithubVerifyState(setupState, "0")).toBeNull();
    expect(toMobileGithubVerifyState(setupState, "4242/other")).toBeNull();
  });

  it("rejects tampering, the wrong signing key, and expiration", () => {
    const token = signMobileGithubState(setupState, key);
    const [payload, signature] = token.split(".");
    const decoded = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as MobileGithubSetupState;
    const forgedPayload = Buffer.from(
      JSON.stringify({ ...decoded, orgId: "org-attacker" }),
      "utf8",
    ).toString("base64url");

    expect(
      verifyMobileGithubState(
        `${forgedPayload}.${signature}`,
        key,
        setupState.exp - 1,
      ),
    ).toBeNull();
    expect(
      verifyMobileGithubState(token, randomBytes(32), setupState.exp - 1),
    ).toBeNull();
    expect(verifyMobileGithubState(token, key, setupState.exp)).toBeNull();
    expect(verifyMobileGithubState("not-signed-state", key)).toBeNull();
  });

  it("rejects legacy state without the user, session, or nonce binding", () => {
    for (const omitted of ["userId", "sessionId", "nonce"] as const) {
      const incomplete = { ...setupState } as Partial<MobileGithubSetupState>;
      delete incomplete[omitted];
      const token = signMobileGithubState(
        incomplete as MobileGithubSetupState,
        key,
      );
      expect(
        verifyMobileGithubState(token, key, setupState.exp - 1),
      ).toBeNull();
    }
  });

  it("allow-lists the native scheme and only Expo Go's exact development route", () => {
    expect(
      validateMobileGithubRedirectUrl("eden://connect", "production"),
    ).toBe("eden://connect");
    expect(
      validateMobileGithubRedirectUrl(
        "exp://192.0.2.10:8081/--/connect",
        "development",
      ),
    ).toBe("exp://192.0.2.10:8081/--/connect");
    expect(
      validateMobileGithubRedirectUrl(
        "exp://192.0.2.10:8081/--/connect",
        "production",
      ),
    ).toBeNull();
    expect(
      validateMobileGithubRedirectUrl(
        "https://attacker.example/connect",
        "development",
      ),
    ).toBeNull();
    expect(
      validateMobileGithubRedirectUrl(
        "exp://192.0.2.10:8081/--/connect?next=evil",
        "development",
      ),
    ).toBeNull();
  });
});

describe("GitHub user installation ownership verification", () => {
  it("checks the installation through the user-token endpoint", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 200 }));

    await expect(
      githubUserCanAccessInstallation("github-user-token", "4242", fetchImpl),
    ).resolves.toBe(true);

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.github.com/user/installations/4242/repositories?per_page=1",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer github-user-token",
        }),
      }),
    );
  });

  it("denies inaccessible or malformed installations and surfaces GitHub outages", async () => {
    const forbidden = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 404 }));
    await expect(
      githubUserCanAccessInstallation("token", "4242", forbidden),
    ).resolves.toBe(false);
    await expect(
      githubUserCanAccessInstallation("token", "raw-id", forbidden),
    ).resolves.toBe(false);
    expect(forbidden).toHaveBeenCalledOnce();

    const unavailable = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 503 }));
    await expect(
      githubUserCanAccessInstallation("token", "4242", unavailable),
    ).rejects.toThrow(/could not verify/i);
  });
});

describe("native GitHub auth-session return", () => {
  const redirectUrl = "eden://connect";

  it("accepts exactly one opaque handoff from the expected native redirect", () => {
    expect(
      githubInstallAuthOutcome(
        {
          type: "success",
          url: mobileGithubHandoffUrl("opaque-handoff", redirectUrl),
        },
        redirectUrl,
      ),
    ).toEqual({ status: "redeem", handoff: "opaque-handoff" });
  });

  it.each(["cancel", "dismiss"] as const)(
    "treats an auth-session %s result as cancellation",
    (type) => {
      expect(githubInstallAuthOutcome({ type }, redirectUrl)).toEqual({
        status: "cancelled",
      });
    },
  );

  it("rejects a wrong redirect, duplicate handoffs, and a raw installation id", () => {
    const wrongRedirect = githubInstallAuthOutcome(
      { type: "success", url: "eden://settings?handoff=opaque" },
      redirectUrl,
    );
    const duplicate = githubInstallAuthOutcome(
      {
        type: "success",
        url: "eden://connect?handoff=one&handoff=two",
      },
      redirectUrl,
    );
    const rawInstallation = githubInstallAuthOutcome(
      { type: "success", url: "eden://connect?installation_id=4242" },
      redirectUrl,
    );

    expect(wrongRedirect).toMatchObject({ status: "error" });
    expect(duplicate).toMatchObject({ status: "error" });
    expect(rawInstallation).toMatchObject({ status: "error" });
    expect(rawInstallation).not.toHaveProperty("installationId");
    expect(rawInstallation).not.toHaveProperty("handoff");
  });

  it("returns the backend's safe denial description", () => {
    expect(
      githubInstallAuthOutcome(
        {
          type: "success",
          url: "eden://connect?error=access_denied&error_description=GitHub+authorization+was+cancelled.",
        },
        redirectUrl,
      ),
    ).toEqual({
      status: "error",
      message: "GitHub authorization was cancelled.",
    });
  });
});
