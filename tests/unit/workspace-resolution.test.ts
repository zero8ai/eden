/**
 * Workspace resolution (issue #56) — the two pure decision helpers behind shared workspaces.
 * `chooseWorkspaceEntry` picks which workspace an org-less session enters (or defers to the
 * chooser); `resolveCrossWorkspaceRedirect` decides whether a project miss is a deep link into
 * another workspace the viewer belongs to. Both are pure over injected inputs, so the branching
 * gets regression coverage without mocking Better Auth or the DB.
 */
import { describe, expect, it, vi } from "vitest";

// This suite exercises the pure workspace decisions. Avoid constructing the database-backed
// Better Auth singleton just to import those helpers.
vi.mock("~/lib/auth.server", () => ({ auth: { api: {} } }));

import { chooseWorkspaceEntry } from "~/auth/workspace.server";
import { resolveCrossWorkspaceRedirect } from "~/project/guard.server";

describe("chooseWorkspaceEntry", () => {
  it("creates a workspace when the user has no memberships", () => {
    expect(chooseWorkspaceEntry({ membershipOrgIds: [] })).toEqual({
      kind: "create",
    });
  });

  it("enters the only workspace when there is exactly one", () => {
    expect(chooseWorkspaceEntry({ membershipOrgIds: ["org_a"] })).toEqual({
      kind: "enter",
      orgId: "org_a",
    });
  });

  it("defers to the chooser when the user belongs to several workspaces", () => {
    expect(
      chooseWorkspaceEntry({ membershipOrgIds: ["org_a", "org_b"] }),
    ).toEqual({
      kind: "choose",
    });
  });
});

describe("resolveCrossWorkspaceRedirect", () => {
  const projects: Record<string, { orgId: string }> = {
    p_a: { orgId: "org_a" },
    p_b: { orgId: "org_b" },
  };
  const findById = async (id: string) => projects[id] ?? null;

  it("returns null for a project already in the current org", async () => {
    const target = await resolveCrossWorkspaceRedirect({
      projectId: "p_a",
      currentOrgId: "org_a",
      findById,
      isMember: async () => true,
    });
    expect(target).toBeNull();
  });

  it("returns the other org when the project lives there and the viewer is a member", async () => {
    const target = await resolveCrossWorkspaceRedirect({
      projectId: "p_b",
      currentOrgId: "org_a",
      findById,
      isMember: async (orgId) => orgId === "org_b",
    });
    expect(target).toBe("org_b");
  });

  it("returns null (404 path) when the viewer is not a member of the other org", async () => {
    const target = await resolveCrossWorkspaceRedirect({
      projectId: "p_b",
      currentOrgId: "org_a",
      findById,
      isMember: async () => false,
    });
    expect(target).toBeNull();
  });

  it("returns null for an unknown project id", async () => {
    const target = await resolveCrossWorkspaceRedirect({
      projectId: "p_missing",
      currentOrgId: "org_a",
      findById,
      isMember: async () => true,
    });
    expect(target).toBeNull();
  });
});
