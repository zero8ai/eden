import { describe, expect, it } from "vitest";

import { isVersionLabelCollision, versionLabel } from "~/deploy/versioning";

describe("versionLabel", () => {
  it("labels the Nth release v(N) — 1-based on existing count", () => {
    expect(versionLabel(0)).toBe("v1");
    expect(versionLabel(1)).toBe("v2");
    expect(versionLabel(41)).toBe("v42");
  });
});

describe("isVersionLabelCollision", () => {
  it("is true for a 23505 on the release version constraint, even when wrapped", () => {
    const driver = Object.assign(new Error("duplicate key"), {
      code: "23505",
      constraint_name: "releases_project_version_uq",
    });
    const wrapped = new Error("insert failed", { cause: driver });
    expect(isVersionLabelCollision(wrapped)).toBe(true);
    expect(isVersionLabelCollision(driver)).toBe(true);
  });

  it("is false for other unique violations or non-pg errors", () => {
    const otherConstraint = Object.assign(new Error("dup"), {
      code: "23505",
      constraint_name: "projects_org_slug_uq",
    });
    expect(isVersionLabelCollision(otherConstraint)).toBe(false);
    expect(isVersionLabelCollision(new Error("nope"))).toBe(false);
    expect(isVersionLabelCollision(null)).toBe(false);
  });
});
