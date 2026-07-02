/**
 * Vercel DeployTarget (PRD §7.4 "other targets, later") — zero-config: Vercel auto-wires the
 * Workflow store, Vercel Sandbox, and AI Gateway. This adapter would call the Vercel API to
 * deploy the eve project; until `VERCEL_TOKEN` is configured, operations throw a clear error.
 *
 * Its presence demonstrates that the DeployTarget seam takes multiple providers with no change
 * to the deploy controller.
 */
import type {
  BuildRequest,
  BuiltArtifact,
  DeployRequest,
  DeployTarget,
  InstanceHealth,
} from "~/seams/types";

class VercelNotConfiguredError extends Error {
  constructor(step: string) {
    super(
      `Vercel deploy step "${step}" needs VERCEL_TOKEN. Configure it to use the Vercel target.`,
    );
    this.name = "VercelNotConfiguredError";
  }
}

export const vercelTarget: DeployTarget = {
  name: "vercel",
  async build(_req: BuildRequest): Promise<BuiltArtifact> {
    // Vercel builds on push; a Release here maps to a Vercel deployment id rather than a digest.
    throw new VercelNotConfiguredError("build");
  },
  async deploy(_req: DeployRequest): Promise<InstanceHealth> {
    throw new VercelNotConfiguredError("deploy");
  },
  async stop(): Promise<void> {
    throw new VercelNotConfiguredError("stop");
  },
  async start(): Promise<InstanceHealth> {
    throw new VercelNotConfiguredError("start");
  },
  async health(): Promise<InstanceHealth> {
    return { status: "pending", detail: "vercel not configured" };
  },
};
