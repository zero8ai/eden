/**
 * Fakes for the infra seams the deploy controller drives (DeployTarget, SecretsProvider), so
 * deployRelease can be unit-tested without docker or a secrets store.
 */
import type {
  DeployTarget,
  InstanceHealth,
  SecretsProvider,
} from "~/seams/types";

/**
 * A DeployTarget whose deploy() resolves to `health` — or, if constructed with an error,
 * throws it (to exercise the controller's failure-recording path, like the real container
 * target does when docker is unavailable).
 */
export function fakeDeployTarget(opts: {
  health?: InstanceHealth;
  deployError?: string;
  buildImageRef?: string;
  /** Captures the env each deploy() received, for injection assertions. */
  deployedEnvs?: Record<string, string>[];
}): DeployTarget {
  return {
    name: "fake",
    async build() {
      return { imageRef: opts.buildImageRef ?? "img:fake", digest: "sha256:fake" };
    },
    async deploy(req): Promise<InstanceHealth> {
      opts.deployedEnvs?.push(req.env);
      if (opts.deployError) throw new Error(opts.deployError);
      return opts.health ?? { status: "live", url: "http://fake.local" };
    },
    async stop() {},
    async start() {
      return { status: "live" };
    },
    async health() {
      return opts.health ?? { status: "live" };
    },
  };
}

/** A no-op SecretsProvider that resolves an (optional) fixed env map. */
export function fakeSecrets(env: Record<string, string> = {}): SecretsProvider {
  return {
    name: "fake",
    async set() {},
    async get() {
      return null;
    },
    async delete() {},
    async listNames() {
      return [];
    },
    async resolve() {
      return env;
    },
  };
}
