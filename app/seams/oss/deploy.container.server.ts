/**
 * OSS DeployTarget: Container + Postgres World (PRD §7.4) — the portable default that
 * underpins both BYO and managed. Builds a container image of the eve Nitro `.output/` and
 * runs it against a Postgres Workflow World.
 *
 * The real build/run pipeline (eve build → docker build → run, ARCH §5) is wired in M2 by the
 * deploy controller; this adapter provides the seam and the shape. Methods that need the
 * `eve`/`docker` toolchain throw a clear, catchable error until the controller enables them,
 * so the control plane degrades gracefully in environments without the toolchain.
 */
import type {
  BuildRequest,
  BuiltArtifact,
  DeployRequest,
  DeployTarget,
  InstanceHealth,
} from "../types";

/** Thrown when a deploy operation needs toolchain/infra not present in this environment. */
export class DeployToolingUnavailableError extends Error {
  constructor(step: string) {
    super(
      `Deploy step "${step}" needs the eve/docker toolchain, which isn't available here yet. ` +
        `Configure a DeployTarget host (see ARCHITECTURE.md §5) to enable deploys.`,
    );
    this.name = "DeployToolingUnavailableError";
  }
}

export const containerPostgresTarget: DeployTarget = {
  name: "container-postgres",

  async build(_req: BuildRequest): Promise<BuiltArtifact> {
    // M2: eve build → docker build → push to registry → return { imageRef, digest }.
    throw new DeployToolingUnavailableError("build");
  },

  async deploy(_req: DeployRequest): Promise<InstanceHealth> {
    // M2: docker run the image with the Postgres World URL + secret env, wire ingress.
    throw new DeployToolingUnavailableError("deploy");
  },

  async stop(_deploymentId: string): Promise<void> {
    throw new DeployToolingUnavailableError("stop");
  },

  async start(_deploymentId: string): Promise<InstanceHealth> {
    throw new DeployToolingUnavailableError("start");
  },

  async health(_deploymentId: string): Promise<InstanceHealth> {
    return { status: "pending", detail: "deploy toolchain not configured" };
  },
};
