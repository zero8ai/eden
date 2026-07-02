/**
 * Just-in-time workspace provisioning (D2: WorkOS Organization == Eden workspace).
 *
 * WorkOS deliberately does not auto-create an organization at signup — the app owns that
 * onboarding step. A user's first org-less request lands here: create their workspace org,
 * add them as its first (admin) member, refresh the session so the access token carries the
 * new organizationId, and replay the request. Users who were invited to an existing org (or
 * abandoned a half-finished signup) adopt their first membership instead of getting a
 * duplicate workspace. Colleague invites are WorkOS organization invitations later — same org.
 */
import { getWorkOS, refreshSession } from "@workos-inc/authkit-react-router";
import { redirect } from "react-router";

import type { SessionAuth } from "./tenant.server";

/**
 * Guarantee the session is org-scoped, creating the user's workspace if needed. Throws a
 * redirect (with refreshed session cookies) when it had to provision/adopt — callers just
 * `await` it before using `auth.organizationId`.
 */
export async function ensureWorkspace(
  request: Request,
  auth: SessionAuth,
): Promise<void> {
  if (auth.organizationId) return;

  const workos = getWorkOS();

  // Adopt an existing membership first (invited users, re-login before session had an org).
  const existing = await workos.userManagement.listOrganizationMemberships({
    userId: auth.user.id,
    statuses: ["active"],
  });
  let organizationId = existing.data[0]?.organizationId;

  if (!organizationId) {
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
    organizationId = org.id;
  }

  // Re-mint the session against the workspace and replay the request with the new cookies.
  const { headers } = await refreshSession(request, { organizationId });
  const url = new URL(request.url);
  throw redirect(url.pathname + url.search, { headers });
}
