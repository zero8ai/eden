import { describe, expect, it, vi } from "vitest";

// installations.server imports the db client at module load; stub it so this pure
// error-type test doesn't stand up a Postgres connection.
vi.mock("~/db/client.server", () => ({ db: {} }));
vi.mock("~/db/schema", () => ({ githubInstallations: {} }));

import {
  GithubReauthorizationError,
  isGithubReauthorizationError,
} from "~/github/installations.server";

describe("GithubReauthorizationError", () => {
  it("is identified by the type guard", () => {
    expect(isGithubReauthorizationError(new GithubReauthorizationError())).toBe(
      true,
    );
  });

  it("does not match a plain Error carrying the same message", () => {
    const plain = new Error(
      "This GitHub installation is not authorized for this workspace. Reauthorize it from Connect.",
    );
    expect(isGithubReauthorizationError(plain)).toBe(false);
  });

  it("does not match unrelated values", () => {
    expect(isGithubReauthorizationError(null)).toBe(false);
    expect(isGithubReauthorizationError("reauthorize")).toBe(false);
  });
});
