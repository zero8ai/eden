/**
 * Agent Portals data access (issue #180): portal CRUD, the email access list (grants), and the
 * turn counters behind the portal rate/spend controls. Grants are checked before an OTP is ever
 * sent AND on every portal request, so revocation bites immediately.
 */
import { and, count, desc, eq, gte, isNull } from "drizzle-orm";

import { db } from "~/db/client.server";
import { account, user } from "~/db/auth-schema";
import {
  chatPortals,
  playgroundSessions,
  portalGrants,
  portalTurns,
} from "~/db/schema";
import { newId } from "~/lib/id";
import type { ReasoningEffort } from "~/models/reasoning";

export type ChatPortal = typeof chatPortals.$inferSelect;
export type PortalGrant = typeof portalGrants.$inferSelect;

const normalizeEmail = (email: string) => email.trim().toLowerCase();

export async function createPortal(input: {
  projectId: string;
  agentId: string;
  name: string;
  createdBy: string;
}): Promise<ChatPortal> {
  const [row] = await db
    .insert(chatPortals)
    .values({
      projectId: input.projectId,
      agentId: input.agentId,
      name: input.name,
      slug: newId(),
      createdBy: input.createdBy,
    })
    .returning();
  return row;
}

/** Portals of one project with live-grant + conversation counts for the admin list. */
export async function listProjectPortals(projectId: string): Promise<
  Array<ChatPortal & { grantCount: number; sessionCount: number }>
> {
  const portals = await db
    .select()
    .from(chatPortals)
    .where(eq(chatPortals.projectId, projectId))
    .orderBy(desc(chatPortals.createdAt));
  if (portals.length === 0) return [];
  const [grantCounts, sessionCounts] = await Promise.all([
    db
      .select({ portalId: portalGrants.portalId, value: count() })
      .from(portalGrants)
      .where(isNull(portalGrants.revokedAt))
      .groupBy(portalGrants.portalId),
    db
      .select({ portalId: playgroundSessions.portalId, value: count() })
      .from(playgroundSessions)
      .groupBy(playgroundSessions.portalId),
  ]);
  const grantsBy = new Map(grantCounts.map((r) => [r.portalId, r.value]));
  const sessionsBy = new Map(sessionCounts.map((r) => [r.portalId, r.value]));
  return portals.map((portal) => ({
    ...portal,
    grantCount: grantsBy.get(portal.id) ?? 0,
    sessionCount: sessionsBy.get(portal.id) ?? 0,
  }));
}

/** Tenancy-guarded load: the portal must belong to the (already org-scoped) project. */
export async function getPortal(
  id: string,
  projectId: string,
): Promise<ChatPortal | null> {
  const [row] = await db
    .select()
    .from(chatPortals)
    .where(and(eq(chatPortals.id, id), eq(chatPortals.projectId, projectId)))
    .limit(1);
  return row ?? null;
}

export async function getPortalBySlug(
  slug: string,
): Promise<ChatPortal | null> {
  const [row] = await db
    .select()
    .from(chatPortals)
    .where(eq(chatPortals.slug, slug))
    .limit(1);
  return row ?? null;
}

export async function updatePortalSettings(input: {
  id: string;
  projectId: string;
  name: string;
  modelId: string | null;
  effort: ReasoningEffort | null;
  turnsPerHour: number;
  monthlyTurnCap: number | null;
}): Promise<boolean> {
  const updated = await db
    .update(chatPortals)
    .set({
      name: input.name,
      modelId: input.modelId,
      effort: input.effort,
      turnsPerHour: input.turnsPerHour,
      monthlyTurnCap: input.monthlyTurnCap,
      updatedAt: new Date(),
    })
    .where(
      and(eq(chatPortals.id, input.id), eq(chatPortals.projectId, input.projectId)),
    )
    .returning({ id: chatPortals.id });
  return updated.length > 0;
}

export async function setPortalDisabled(input: {
  id: string;
  projectId: string;
  disabled: boolean;
}): Promise<void> {
  await db
    .update(chatPortals)
    .set({ disabledAt: input.disabled ? new Date() : null, updatedAt: new Date() })
    .where(
      and(eq(chatPortals.id, input.id), eq(chatPortals.projectId, input.projectId)),
    );
}

export async function listGrants(portalId: string): Promise<PortalGrant[]> {
  return db
    .select()
    .from(portalGrants)
    .where(eq(portalGrants.portalId, portalId))
    .orderBy(desc(portalGrants.createdAt));
}

/** Add an email to the access list; re-inviting a revoked email revives the grant. */
export async function upsertGrant(input: {
  portalId: string;
  email: string;
  invitedBy: string;
}): Promise<PortalGrant> {
  const [row] = await db
    .insert(portalGrants)
    .values({
      portalId: input.portalId,
      email: normalizeEmail(input.email),
      invitedBy: input.invitedBy,
    })
    .onConflictDoUpdate({
      target: [portalGrants.portalId, portalGrants.email],
      set: { revokedAt: null, invitedBy: input.invitedBy },
    })
    .returning();
  return row;
}

export async function revokeGrant(input: {
  portalId: string;
  grantId: string;
}): Promise<void> {
  await db
    .update(portalGrants)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(portalGrants.id, input.grantId),
        eq(portalGrants.portalId, input.portalId),
      ),
    );
}

/** The live (non-revoked) grant matching this email on this portal, if any. */
export async function findLiveGrant(
  portalId: string,
  email: string,
): Promise<PortalGrant | null> {
  const [row] = await db
    .select()
    .from(portalGrants)
    .where(
      and(
        eq(portalGrants.portalId, portalId),
        eq(portalGrants.email, normalizeEmail(email)),
        isNull(portalGrants.revokedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * The newest enabled portal holding a live grant for this email, or null — the gate on sending
 * sign-in OTPs at all (see shouldSendPortalOtp in ./policy), and the name to address the OTP
 * email with.
 */
export async function findLivePortalForEmail(
  email: string,
): Promise<{ portalName: string } | null> {
  const [row] = await db
    .select({ portalName: chatPortals.name })
    .from(portalGrants)
    .innerJoin(chatPortals, eq(portalGrants.portalId, chatPortals.id))
    .where(
      and(
        eq(portalGrants.email, normalizeEmail(email)),
        isNull(portalGrants.revokedAt),
        isNull(chatPortals.disabledAt),
      ),
    )
    .orderBy(desc(portalGrants.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * Where a signed-in PORTAL GUEST belongs instead of the Eden app (issue #180). A guest is a
 * user minted by the OTP sign-in: no credential account (email/password signup always creates
 * one) and at least one live grant. Returns the newest granted portal's chat path, or null for
 * ordinary users — `ensureWorkspace` uses this to avoid provisioning a personal workspace for
 * a guest who wanders onto an app route.
 */
export async function portalGuestHome(input: {
  userId: string;
  email: string;
}): Promise<string | null> {
  const [credential] = await db
    .select({ id: account.id })
    .from(account)
    .where(
      and(eq(account.userId, input.userId), eq(account.providerId, "credential")),
    )
    .limit(1);
  if (credential) return null;
  const [grant] = await db
    .select({ slug: chatPortals.slug })
    .from(portalGrants)
    .innerJoin(chatPortals, eq(portalGrants.portalId, chatPortals.id))
    .where(
      and(
        eq(portalGrants.email, normalizeEmail(input.email)),
        isNull(portalGrants.revokedAt),
        isNull(chatPortals.disabledAt),
      ),
    )
    .orderBy(desc(portalGrants.createdAt))
    .limit(1);
  return grant ? `/a/${grant.slug}` : null;
}

/** Record one accepted turn (feeds the rate/spend counters). */
export async function recordPortalTurn(input: {
  portalId: string;
  userId: string;
}): Promise<void> {
  await db
    .insert(portalTurns)
    .values({ portalId: input.portalId, userId: input.userId });
}

/** The two windowed counters evaluatePortalTurn needs, in one round-trip each. */
export async function portalTurnCounts(input: {
  portalId: string;
  userId: string;
}): Promise<{ guestTurnsLastHour: number; portalTurnsLast30d: number }> {
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [[guest], [portal]] = await Promise.all([
    db
      .select({ value: count() })
      .from(portalTurns)
      .where(
        and(
          eq(portalTurns.portalId, input.portalId),
          eq(portalTurns.userId, input.userId),
          gte(portalTurns.createdAt, hourAgo),
        ),
      ),
    db
      .select({ value: count() })
      .from(portalTurns)
      .where(
        and(
          eq(portalTurns.portalId, input.portalId),
          gte(portalTurns.createdAt, monthAgo),
        ),
      ),
  ]);
  return {
    guestTurnsLastHour: guest?.value ?? 0,
    portalTurnsLast30d: portal?.value ?? 0,
  };
}

/** Portal conversations joined with their guest's identity — the builder transcript list. */
export async function listPortalSessionsWithGuests(portalId: string): Promise<
  Array<{
    id: string;
    title: string | null;
    status: string;
    updatedAt: Date;
    guestEmail: string | null;
    guestName: string | null;
  }>
> {
  return db
    .select({
      id: playgroundSessions.id,
      title: playgroundSessions.title,
      status: playgroundSessions.status,
      updatedAt: playgroundSessions.updatedAt,
      guestEmail: user.email,
      guestName: user.name,
    })
    .from(playgroundSessions)
    .leftJoin(user, eq(playgroundSessions.createdBy, user.id))
    .where(eq(playgroundSessions.portalId, portalId))
    .orderBy(desc(playgroundSessions.updatedAt));
}

/** Turns across the trailing 30 days, for the admin usage line. */
export async function portalTurnsLast30d(portalId: string): Promise<number> {
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [row] = await db
    .select({ value: count() })
    .from(portalTurns)
    .where(
      and(
        eq(portalTurns.portalId, portalId),
        gte(portalTurns.createdAt, monthAgo),
      ),
    );
  return row?.value ?? 0;
}
