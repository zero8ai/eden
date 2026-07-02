/**
 * Managed MeteringSink (PRD §7.5, ARCH §3.4). Records usage events (like the OSS sink);
 * Stripe reconciliation lands with real billing (M4 follow-up).
 */
import { db } from "~/db/client.server";
import { usageEvents } from "~/db/schema";
import type { MeteringSink } from "~/seams/types";

export const managedMeteringSink: MeteringSink = {
  name: "managed-stripe",
  async record(event) {
    await db.insert(usageEvents).values({
      orgId: event.orgId,
      deploymentId: event.deploymentId ?? null,
      kind: event.kind,
      quantity: Math.round(event.quantity),
      at: new Date(event.at),
      meta: event.meta ?? {},
    });
  },
};
