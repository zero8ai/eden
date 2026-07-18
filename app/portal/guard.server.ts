/**
 * Portal access guard (issue #180). A portal guest needs a Better Auth session PLUS a live
 * grant on THIS portal — org membership is deliberately never consulted, so guest sessions are
 * useful only for portals they've been granted, and grants/revocations bite on every request.
 */
import { data } from "react-router";

import type { SessionState } from "~/auth/session.server";
import {
  findLiveGrant,
  getPortalBySlug,
  type ChatPortal,
} from "~/portal/portals.server";

/** Resolve an ENABLED portal from its public slug, or 404. Disabled portals 404 too — a
 * switched-off portal should be indistinguishable from one that never existed. */
export async function requirePortalBySlug(
  slug: string | undefined,
): Promise<ChatPortal> {
  const portal = slug ? await getPortalBySlug(slug) : null;
  if (!portal || portal.disabledAt) {
    throw data("Not found", { status: 404 });
  }
  return portal;
}

export type PortalAccess =
  | { state: "granted"; userId: string; email: string }
  /** Signed in, but this email has no live grant here (or was revoked). */
  | { state: "denied"; email: string }
  | { state: "anonymous" };

/** Classify the current session against one portal's access list. */
export async function resolvePortalAccess(
  session: SessionState,
  portal: ChatPortal,
): Promise<PortalAccess> {
  if (!session.user) return { state: "anonymous" };
  const grant = await findLiveGrant(portal.id, session.user.email);
  if (!grant) return { state: "denied", email: session.user.email };
  return {
    state: "granted",
    userId: session.user.id,
    email: session.user.email,
  };
}

/** API-route variant: throw JSON 401/403 instead of rendering the sign-in screen. */
export async function requirePortalGuest(
  session: SessionState,
  portal: ChatPortal,
): Promise<{ userId: string; email: string }> {
  const access = await resolvePortalAccess(session, portal);
  if (access.state === "anonymous") {
    throw data({ error: "Sign in to use this portal." }, { status: 401 });
  }
  if (access.state === "denied") {
    throw data(
      { error: "This email does not have access to this portal." },
      { status: 403 },
    );
  }
  return { userId: access.userId, email: access.email };
}
