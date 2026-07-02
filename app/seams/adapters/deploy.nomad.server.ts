/**
 * Managed DeployTarget: bare-metal Docker via Nomad (ARCH §2.1/§3.1) — the managed substrate.
 *
 * Builds the image, pushes to the box's local registry, provisions the instance's Postgres DB
 * + secrets, and submits a Nomad job with the gVisor runtime; scale-to-zero stops/starts the
 * allocation. The Nomad API + box are infra; this adapter is the seam. Until a Nomad endpoint
 * (`NOMAD_ADDR`) is configured, operations throw a clear, catchable error.
 */
import type {
  BuildRequest,
  BuiltArtifact,
  DeployRequest,
  DeployTarget,
  InstanceHealth,
} from "~/seams/types";

class NomadNotConfiguredError extends Error {
  constructor(step: string) {
    super(
      `Nomad deploy step "${step}" needs NOMAD_ADDR + a build host (ARCH §2). ` +
        `Configure the bare-metal substrate to enable managed deploys.`,
    );
    this.name = "NomadNotConfiguredError";
  }
}

export const nomadTarget: DeployTarget = {
  name: "bare-metal-nomad",
  async build(_req: BuildRequest): Promise<BuiltArtifact> {
    throw new NomadNotConfiguredError("build");
  },
  async deploy(_req: DeployRequest): Promise<InstanceHealth> {
    throw new NomadNotConfiguredError("deploy");
  },
  async stop(): Promise<void> {
    throw new NomadNotConfiguredError("stop");
  },
  async start(): Promise<InstanceHealth> {
    throw new NomadNotConfiguredError("start");
  },
  async health(): Promise<InstanceHealth> {
    return { status: "pending", detail: "nomad not configured" };
  },
};
