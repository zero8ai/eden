/**
 * Workspace resolution + provisioning (D2: WorkOS Organization == Eden workspace).
 *
 * WorkOS deliberately does not auto-create an organization at signup — the app owns that
 * onboarding step, and a user may belong to several workspaces (shared workspaces, issue #56).
 * A user's org-less request lands here; `ensureWorkspace` decides which workspace to enter and
 * re-mints the session against it, replaying the original request. The decision:
 *
 *   1. Already org-scoped → nothing to do.
 *   2. No WorkOS memberships → create the user's personal workspace + first (admin) membership.
 *   3. `users.lastOrgId` still points at a current membership → re-enter it (returning user).
 *   4. Exactly one membership → adopt it (invited user, or single-workspace user).
 *   5. Several memberships, no usable last-active → send them to the `/workspaces` chooser.
 *
 * The chooser/switcher must read live WorkOS memberships (not our `memberships` mirror): a
 * freshly-invited, never-entered workspace has no mirror row yet. WorkOS is the source of truth
 * for "which workspaces am I in".
 */
import { getWorkOS, refreshSession } from "@workos-inc/authkit-react-router";
import { eq } from "drizzle-orm";
import { redirect } from "react-router";

import { db } from "~/db/client.server";
import { users } from "~/db/schema";
import type { SessionAuth } from "./tenant.server";

/**
 * Pure workspace-entry decision, split out so the branching is unit-testable without mocking
 * WorkOS. `membershipOrgIds` is the user's live active memberships; `lastOrgId` is the
 * remembered last-active workspace (may be stale or null).
 */
export function chooseWorkspaceEntry(input: {
  membershipOrgIds: string[];
  lastOrgId: string | null;
}): { kind: "create" } | { kind: "enter"; orgId: string } | { kind: "choose" } {
  const { membershipOrgIds, lastOrgId } = input;
  if (membershipOrgIds.length === 0) return { kind: "create" };
  // Prefer the remembered workspace, but only if it's still one the user belongs to.
  if (lastOrgId && membershipOrgIds.includes(lastOrgId)) {
    return { kind: "enter", orgId: lastOrgId };
  }
  if (membershipOrgIds.length === 1) return { kind: "enter", orgId: membershipOrgIds[0] };
  return { kind: "choose" };
}

/**
 * The user's workspaces from WorkOS (the authoritative membership list, incl. never-entered
 * invites). Shared by the chooser, the shell switcher's resource route, and `ensureWorkspace`.
 */
export async function listUserWorkspaces(
  userId: string,
): Promise<{ id: string; name: string }[]> {
  const { data } = await getWorkOS().userManagement.listOrganizationMemberships({
    userId,
    statuses: ["active"],
  });
  return data.map((m) => ({
    id: m.organizationId,
    name: m.organizationName ?? m.organizationId,
  }));
}

/** Create the user's personal workspace + their first (admin) membership. Returns the org id. */
async function createPersonalWorkspace(auth: SessionAuth): Promise<string> {
  const workos = getWorkOS();
  const first =
    auth.user.firstName?.trim() || auth.user.email.split("@")[0] || "My";
  const org = await workos.organizations.createOrganization({
    name: `${first}'s workspace`,
  });
  try {
    await workos.userManagement.createOrganizationMembership({
      userId: auth.user.id,
      organizationId: org.id,
      roleSlug: "admin",
    });
  } catch {
    // Environment has no "admin" role defined — fall back to the default role.
    await workos.userManagement.createOrganizationMembership({
      userId: auth.user.id,
      organizationId: org.id,
    });
  }
  return org.id;
}

/**
 * Guarantee the session is org-scoped, provisioning/adopting/choosing a workspace as needed.
 * Throws a redirect (with refreshed session cookies, or to the chooser) when it had to act —
 * callers just `await` it before using `auth.organizationId`.
 */
export async function ensureWorkspace(
  request: Request,
  auth: SessionAuth,
): Promise<void> {
  if (auth.organizationId) return;

  const url = new URL(request.url);
  const replayTo = url.pathname + url.search;

  const workspaces = await listUserWorkspaces(auth.user.id);
  const membershipOrgIds = workspaces.map((w) => w.id);

  // Read the remembered workspace; the row may not exist yet (first-ever request) → null.
  const [row] = await db
    .select({ lastOrgId: users.lastOrgId })
    .from(users)
    .where(eq(users.id, auth.user.id))
    .limit(1);
  const lastOrgId = row?.lastOrgId ?? null;

  const decision = chooseWorkspaceEntry({ membershipOrgIds, lastOrgId });

  if (decision.kind === "choose") {
    throw redirect(`/workspaces?returnTo=${encodeURIComponent(replayTo)}`);
  }

  const organizationId =
    decision.kind === "create"
      ? await createPersonalWorkspace(auth)
      : decision.orgId;

  // Re-mint the session against the workspace and replay the request with the new cookies.
  const { headers } = await refreshSession(request, { organizationId });
  throw redirect(replayTo, { headers });
}
