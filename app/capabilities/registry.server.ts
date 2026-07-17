/**
 * Capability registry (issue #166) — every provider with a brokered-capability definition, keyed
 * by the OAuth broker provider id it consumes (issue #163 registry). A second capability provider
 * is a definition module + a `PROVIDERS` entry with `credentialDelivery: "capability"` + a catalog
 * template — no new routes, schema, or UI. Unknown provider → null; unlisted operations do not
 * exist (the generic route 404s).
 */
import type { CapabilityDefinition } from "./definition.server";
import { xeroCapability } from "./xero.server";

export const CAPABILITIES: Record<string, CapabilityDefinition> = {
  xero: xeroCapability,
};

/** The capability definition for a provider id, or null when it has none. */
export function getCapability(provider: string): CapabilityDefinition | null {
  return CAPABILITIES[provider] ?? null;
}

/** Every registered capability definition. */
export function listCapabilities(): CapabilityDefinition[] {
  return Object.values(CAPABILITIES);
}
