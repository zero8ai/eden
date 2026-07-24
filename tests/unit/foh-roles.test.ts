/**
 * House gating (FOH invites & roles, D10): `isBackOfHouse` decides which org roles may enter
 * the build surface, and `requireBackOfHouse` enforces it — redirect home for page routes,
 * 403 JSON for API/resource routes. Pure over an ActiveWorkspace, no Better Auth needed.
 */
import { describe, expect, it, vi } from "vitest";

// Pure role decisions only — never construct the database-backed Better Auth singleton.
vi.mock("~/lib/auth.server", () => ({ auth: { api: {} } }));

import {
  isBackOfHouse,
  requireBackOfHouse,
  type ActiveWorkspace,
} from "~/auth/workspace.server";

function active(role: string): ActiveWorkspace {
  return {
    org: { id: "org_1", name: "Workspace", slug: "workspace" },
    member: { id: "mem_1", organizationId: "org_1", userId: "user_1", role },
  };
}

describe("isBackOfHouse", () => {
  it("admits owners and admins, turns members away", () => {
    expect(isBackOfHouse("owner")).toBe(true);
    expect(isBackOfHouse("admin")).toBe(true);
    expect(isBackOfHouse("member")).toBe(false);
  });

  it("handles Better Auth's comma-separated multi-role grants", () => {
    expect(isBackOfHouse("member,admin")).toBe(true);
    expect(isBackOfHouse("owner, member")).toBe(true);
    expect(isBackOfHouse("member,member")).toBe(false);
  });

  it("never matches on substrings or unknown roles", () => {
    expect(isBackOfHouse("administrator")).toBe(false);
    expect(isBackOfHouse("co-owner")).toBe(false);
    expect(isBackOfHouse("")).toBe(false);
  });
});

describe("requireBackOfHouse", () => {
  it("is a no-op for owners and admins in both modes", () => {
    expect(() => requireBackOfHouse(active("owner"), "page")).not.toThrow();
    expect(() => requireBackOfHouse(active("admin"), "api")).not.toThrow();
  });

  it("redirects a member to the FOH home from page routes", () => {
    let thrown: unknown;
    try {
      requireBackOfHouse(active("member"), "page");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(302);
    expect((thrown as Response).headers.get("location")).toBe("/");
  });

  it("throws 403 JSON at a member on API routes and mutations", async () => {
    let thrown: unknown;
    try {
      requireBackOfHouse(active("member"), "api");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Response);
    const response = thrown as Response;
    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(((await response.json()) as { error: string }).error).toMatch(
      /back of house/i,
    );
  });
});
