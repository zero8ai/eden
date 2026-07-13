import { describe, expect, it } from "vitest";

import { mobileApi } from "../../packages/api-contract/src";
import { mobileTrustedOrigins } from "../../app/lib/mobile-auth";
import { nativeAction } from "../../app/lib/mobile-resource.server";
import { hasValidMutationOrigin } from "../../app/auth/session.server";

describe("mobile foundation", () => {
  it("trusts native schemes without exposing Expo development origins in production", () => {
    expect(mobileTrustedOrigins("production")).toEqual(["eden://", "eden://*"]);
    expect(mobileTrustedOrigins("development")).toContain("exp://*");
  });

  it("builds encoded repository and member API paths", () => {
    expect(mobileApi.repository("owner/repo")).toBe(
      "/api/mobile/repos/owner%2Frepo",
    );
    expect(mobileApi.memberPage("project", "Research Bot", "runs")).toBe(
      "/api/mobile/repos/project/agents/Research%20Bot/runs",
    );
  });

  it("turns shared web action redirects into native JSON navigation", async () => {
    const action = nativeAction(async () =>
      Response.redirect("https://eden.example/dashboard", 303),
    );
    const response = await action(undefined);
    expect(response).toBeInstanceOf(Response);
    await expect((response as Response).json()).resolves.toEqual({
      ok: true,
      redirectTo: "https://eden.example/dashboard",
    });
  });

  it("accepts the configured server origin for native mutations", () => {
    const previous = process.env.BETTER_AUTH_URL;
    process.env.BETTER_AUTH_URL = "https://eden.example";
    try {
      expect(
        hasValidMutationOrigin(
          new Request("https://eden.example/api/mobile/workspaces", {
            method: "POST",
            headers: { Origin: "https://eden.example" },
          }),
        ),
      ).toBe(true);
      expect(
        hasValidMutationOrigin(
          new Request("https://eden.example/api/mobile/workspaces", {
            method: "POST",
            headers: { Origin: "eden://" },
          }),
        ),
      ).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.BETTER_AUTH_URL;
      else process.env.BETTER_AUTH_URL = previous;
    }
  });
});
