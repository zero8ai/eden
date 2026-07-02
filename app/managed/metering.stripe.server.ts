/**
 * Managed MeteringSink (PRD §7.5, ARCH §3.4). Records usage events (like the OSS sink) and can
 * reconcile aggregated usage into Stripe usage records. The Stripe push requires STRIPE_API_KEY
 * + a configured meter; without them, reconciliation is a no-op that reports what it *would*
 * send, so the control plane runs without billing configured.
 */
import { db } from "~/db/client.server";
import { usageEvents } from "~/db/schema";
import { tokensUsedSince } from "./billing.server";
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

export interface ReconcileResult {
  orgId: string;
  tokens: number;
  pushed: boolean;
  detail: string;
}

/** Aggregate the month's token usage for a tenant and push a Stripe usage record. */
export async function reconcileToStripe(orgId: string): Promise<ReconcileResult> {
  const tokens = await tokensUsedSince(orgId);
  const key = process.env.STRIPE_API_KEY;
  const meter = process.env.STRIPE_TOKENS_METER;
  if (!key || !meter) {
    return {
      orgId,
      tokens,
      pushed: false,
      detail: "STRIPE_API_KEY/STRIPE_TOKENS_METER not set — skipped push.",
    };
  }
  // Push a meter event to Stripe's billing meters API.
  const res = await fetch("https://api.stripe.com/v1/billing/meter_events", {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      event_name: meter,
      "payload[value]": String(tokens),
      "payload[stripe_customer_id]": orgId,
    }),
  });
  return {
    orgId,
    tokens,
    pushed: res.ok,
    detail: res.ok ? "pushed" : `stripe error ${res.status}`,
  };
}
