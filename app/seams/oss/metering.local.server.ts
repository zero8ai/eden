/**
 * OSS MeteringSink: append usage events to Postgres for local visibility. Managed swaps in a
 * sink that aggregates and pushes Stripe usage records (ARCH §3.4) behind the same seam.
 */
import { db } from "~/db/client.server";
import { usageEvents } from "~/db/schema";
import type { MeteringSink } from "../types";

export const localMeteringSink: MeteringSink = {
  name: "local-usage-log",
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
