/**
 * Spend controls + usage aggregation shared by the managed gateway and billing (ARCH §3.4).
 * The month's metered token usage per tenant, and the spend-limit read/write. Kept provider-
 * agnostic; the Stripe push lives in metering.stripe.server.ts.
 */
import { and, eq, gte, sql } from "drizzle-orm";

import { db } from "~/db/client.server";
import { spendLimits, usageEvents } from "~/db/schema";

/** Total metered `model_tokens` for an org since the given ISO instant (default: 30 days). */
export async function tokensUsedSince(orgId: string, sinceIso?: string): Promise<number> {
  const since = sinceIso ? new Date(sinceIso) : new Date(Date.now() - 30 * 864e5);
  const [{ total }] = await db
    .select({ total: sql<number>`coalesce(sum(${usageEvents.quantity}), 0)::int` })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.orgId, orgId),
        eq(usageEvents.kind, "model_tokens"),
        gte(usageEvents.at, since),
      ),
    );
  return total ?? 0;
}

export type SpendLimit = typeof spendLimits.$inferSelect;

export async function getSpendLimit(orgId: string): Promise<SpendLimit | undefined> {
  const [row] = await db
    .select()
    .from(spendLimits)
    .where(eq(spendLimits.orgId, orgId))
    .limit(1);
  return row;
}

export async function setSpendLimit(
  orgId: string,
  input: { monthlyTokenCap: number | null; killSwitch: boolean },
): Promise<void> {
  await db
    .insert(spendLimits)
    .values({ orgId, monthlyTokenCap: input.monthlyTokenCap, killSwitch: input.killSwitch })
    .onConflictDoUpdate({
      target: spendLimits.orgId,
      set: {
        monthlyTokenCap: input.monthlyTokenCap,
        killSwitch: input.killSwitch,
        updatedAt: new Date(),
      },
    });
}
