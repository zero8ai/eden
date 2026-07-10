import { APIError } from "better-auth/api";
import { describe, expect, it } from "vitest";

import { publicAuthErrorMessage } from "~/lib/auth-error.server";

describe("public Better Auth errors", () => {
  it("keeps documented client-facing API errors", () => {
    const error = new APIError("CONFLICT", {
      code: "INVITATION_ALREADY_EXISTS",
      message: "An invitation is already pending for this address.",
    });
    expect(publicAuthErrorMessage(error, "Fallback")).toBe(
      "An invitation is already pending for this address.",
    );
  });

  it("hides Better Auth 5xx diagnostics", () => {
    const error = new APIError("INTERNAL_SERVER_ERROR", {
      message: "select * from verification where token = secret-token",
    });
    expect(publicAuthErrorMessage(error, "Safe fallback")).toBe(
      "Safe fallback",
    );
  });

  it("hides non-API adapter errors", () => {
    expect(
      publicAuthErrorMessage(
        new Error("Failed query with invitation-id and member@example.com"),
        "Safe fallback",
      ),
    ).toBe("Safe fallback");
  });
});
