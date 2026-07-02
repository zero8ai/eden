/**
 * Bridges a WorkOS session to Eden's control-plane tables.
 *
 * WorkOS is authoritative for identity/tenancy (D2); we keep a thin mirror so our own rows
 * (projects, memberships, …) have FKs to point at and loaders can authorize without a WorkOS
 * round-trip. `syncTenant` is called at the top of authenticated loaders: it upserts the
 * current user, their org, and their membership from the verified session claims.
 */
import { getWorkOS } from "@workos-inc/authkit-react-router";
import { eq } from "drizzle-orm";

import { db } from "~/db/client.server";
import { memberships, orgs, users } from "~/db/schema";

/** The subset of AuthKit's AuthorizedData we depend on. */
export type SessionAuth = {
  user: {
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
  };
  organizationId: string | null;
  role: string | null;
};

export type Org = typeof orgs.$inferSelect;

/**
 * Idempotently mirror the session's user + org + membership into Postgres.
 * Returns the org row, or null when the session is not org-scoped (a user signed in
 * without selecting/belonging to an organization).
 */
export async function syncTenant(
  auth: SessionAuth,
): Promise<{ org: Org | null }> {
  const displayName =
    [auth.user.firstName, auth.user.lastName].filter(Boolean).join(" ") || null;

  // Start the user upsert but only await it where it's needed, so the org-less
  // path doesn't block on it and the org path overlaps it with the org lookup.
  const userSync = db
    .insert(users)
    .values({ id: auth.user.id, email: auth.user.email, name: displayName })
    .onConflictDoUpdate({
      target: users.id,
      set: { email: auth.user.email, name: displayName },
    });

  if (!auth.organizationId) {
    await userSync;
    return { org: null };
  }

  // The membership insert below FKs users(id), so userSync must settle first —
  // but the org lookup is independent and can run concurrently with it.
  const [, [orgRow]] = await Promise.all([
    userSync,
    db.select().from(orgs).where(eq(orgs.id, auth.organizationId)).limit(1),
  ]);
  let org = orgRow;

  if (!org) {
    // First time we've seen this org — resolve its display name from WorkOS.
    // Fall back to the id if the lookup fails, so a transient API error doesn't
    // block the session.
    let name = auth.organizationId;
    try {
      const remote = await getWorkOS().organizations.getOrganization(
        auth.organizationId,
      );
      name = remote.name;
    } catch {
      // keep the id as a placeholder name
    }
    [org] = await db
      .insert(orgs)
      .values({ id: auth.organizationId, name })
      .onConflictDoUpdate({ target: orgs.id, set: { name } })
      .returning();
  }

  await db
    .insert(memberships)
    .values({
      orgId: auth.organizationId,
      userId: auth.user.id,
      role: auth.role ?? "member",
    })
    .onConflictDoUpdate({
      target: [memberships.orgId, memberships.userId],
      set: { role: auth.role ?? "member" },
    });

  return { org };
}
