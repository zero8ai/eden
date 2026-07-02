/**
 * Runtime registry — the single place that binds the seams (types.ts) to concrete
 * implementations for the current `EDEN_MODE` (PRD §8, ARCH §1.5). Everything else in the
 * app depends on `getRuntime()`, never on a concrete provider, so OSS and managed stay one
 * codebase with no fork.
 *
 * `EDEN_MODE=oss` (default) wires the local/BYO reference implementations. `EDEN_MODE=managed`
 * will wire the KMS/gateway/Stripe/Nomad implementations as they land (M4); until then it
 * falls back to the OSS impls so the control plane still boots.
 */
import { managedMeteringSink } from "~/managed/metering.stripe.server";
import { managedModelGateway } from "~/managed/gateway.proxy.server";
import { containerPostgresTarget } from "./oss/deploy.container.server";
import { directModelGateway } from "./oss/gateway.direct.server";
import { localMeteringSink } from "./oss/metering.local.server";
import { localScheduler } from "./oss/scheduler.local.server";
import { localSecretsProvider } from "./oss/secrets.local.server";
import { localTelemetrySink } from "./oss/telemetry.local.server";
import type { EdenMode, EdenRuntime } from "./types";

function resolveMode(): EdenMode {
  return process.env.EDEN_MODE === "managed" ? "managed" : "oss";
}

function buildRuntime(mode: EdenMode): EdenRuntime {
  // Managed-only implementations (KMS secrets, gateway proxy, Stripe metering, Nomad target)
  // are introduced in M4 and swapped in here by mode. Until then both modes share the OSS
  // reference impls; the seam boundary means that swap is local to this file.
  const managed = mode === "managed";
  return {
    mode,
    // Deploy target + secrets: managed KMS/Nomad impls land as they're built; OSS refs for now.
    deployTarget: containerPostgresTarget,
    secrets: localSecretsProvider,
    scheduler: localScheduler,
    telemetry: localTelemetrySink,
    // Managed swaps in the gateway proxy (keys/metering/caps) and Stripe metering.
    modelGateway: managed ? managedModelGateway : directModelGateway,
    metering: managed ? managedMeteringSink : localMeteringSink,
  };
}

let cached: EdenRuntime | undefined;

/** The runtime implementations selected for this process. Cached after first resolution. */
export function getRuntime(): EdenRuntime {
  return (cached ??= buildRuntime(resolveMode()));
}
