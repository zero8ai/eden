/**
 * Workspace resolution (issue #56) — the two pure decision helpers behind shared workspaces.
 * `chooseWorkspaceEntry` picks which workspace an org-less session enters (or defers to the
 * chooser); `resolveCrossWorkspaceRedirect` decides whether a project miss is a deep link into
 * another workspace the viewer belongs to. Both are pure over injected inputs, so the branching
 * gets regression coverage without mocking WorkOS or the DB.
 */
import { describe, expect, it } from "vitest";

import { chooseWorkspaceEntry } from "~/auth/workspace.server";
import { resolveCrossWorkspaceRedirect } from "~/project/guard.server";

describe("chooseWorkspaceEntry", () => {
  it("creates a workspace when the user has no memberships", () => {
    expect(chooseWorkspaceEntry({ membershipOrgIds: [], lastOrgId: null })).toEqual({
      kind: "create",
    });
    // A stale lastOrgId can't resurrect a workspace the user no longer belongs to.
    expect(chooseWorkspaceEntry({ membershipOrgIds: [], lastOrgId: "org_dead" })).toEqual({
      kind: "create",
    });
  });

  it("enters the only workspace when there is exactly one", () => {
    expect(chooseWorkspaceEntry({ membershipOrgIds: ["org_a"], lastOrgId: null })).toEqual({
      kind: "enter",
      orgId: "org_a",
    });
  });

  it("re-enters the remembered workspace when it is still a membership", () => {
    expect(
      chooseWorkspaceEntry({ membershipOrgIds: ["org_a", "org_b"], lastOrgId: "org_b" }),
    ).toEqual({ kind: "enter", orgId: "org_b" });
  });

  it("defers to the chooser with several memberships and no usable last-active", () => {
    expect(
      chooseWorkspaceEntry({ membershipOrgIds: ["org_a", "org_b"], lastOrgId: null }),
    ).toEqual({ kind: "choose" });
    // lastOrgId points at a workspace the user no longer belongs to → still choose.
    expect(
      chooseWorkspaceEntry({ membershipOrgIds: ["org_a", "org_b"], lastOrgId: "org_gone" }),
    ).toEqual({ kind: "choose" });
  });

  it("adopts the single membership even when last-active is stale", () => {
    expect(
      chooseWorkspaceEntry({ membershipOrgIds: ["org_a"], lastOrgId: "org_gone" }),
    ).toEqual({ kind: "enter", orgId: "org_a" });
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
