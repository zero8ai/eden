import { mkdir } from "node:fs/promises";

import { beforeEach, describe, expect, it, vi } from "vitest";

const execFile = vi.fn(
  (
    cmd: string,
    args: string[],
    optionsOrCallback:
      | { maxBuffer?: number }
      | ((error: Error | null, stdout: string, stderr: string) => void),
    maybeCallback?: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    const callback =
      typeof optionsOrCallback === "function"
        ? optionsOrCallback
        : maybeCallback!;

    if (cmd === "mkdir") {
      mkdir(args[1], { recursive: true }).then(
        () => callback(null, "", ""),
        (error) => callback(error, "", ""),
      );
      return;
    }

    if (cmd === "tar") {
      const target = args[args.indexOf("-C") + 1];
      mkdir(target, { recursive: true }).then(
        () => callback(null, "", ""),
        (error) => callback(error, "", ""),
      );
      return;
    }

    callback(null, "", "");
  },
);

vi.mock("node:child_process", () => ({ execFile }));

vi.mock("~/github/client.server", () => ({
  getInstallationOctokit: vi.fn(async () => ({
    request: vi.fn(async () => ({ data: new ArrayBuffer(0) })),
  })),
}));

describe("checkEveBuild", () => {
  beforeEach(() => {
    execFile.mockClear();
  });

  it("creates a missing new-member package directory before adding the Dockerfile", async () => {
    const { checkEveBuild } = await import("~/deploy/eve-image.server");

    await expect(
      checkEveBuild({
        projectId: "proj_1",
        repo: { owner: "acme", repo: "agents" },
        ref: "abc123",
        installationId: "inst_1",
        agentRoot: "agents/cloudflare-dev/agent",
        overlay: [
          {
            path: "agents/cloudflare-dev/package.json",
            content: JSON.stringify({ scripts: { build: "eve build" } }),
          },
          {
            path: "agents/cloudflare-dev/agent/agent.ts",
            content: "export default {};",
          },
        ],
      }),
    ).resolves.toEqual({ ok: true });

    expect(execFile).toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining(["build", "--target", "build"]),
      expect.any(Object),
      expect.any(Function),
    );
  });
});

/**
 * The generated agent Dockerfile — the contract the deploy pipeline bakes into every image.
 *
 * Pins the fix for the sandbox-template bug: images must boot via `eve start` (which prewarms
 * `eve-sbx-tpl-*` template images BEFORE the server binds its port) from a runtime stage that
 * inherits the full build stage (`eve start` needs node_modules + .eve/compile). Booting the
 * raw Nitro entry left every skills/bootstrap-carrying agent permanently unable to use its
 * bash tools (SandboxTemplateNotProvisionedError; self-heal is disabled for built servers).
 */
describe("EDEN_EVE_DOCKERFILE", () => {
  it("boots via the eve bin (`eve start`), not the raw Nitro entry", async () => {
    const { EDEN_EVE_DOCKERFILE } = await import("~/deploy/eve-image.server");
    expect(EDEN_EVE_DOCKERFILE).toContain('CMD ["node_modules/.bin/eve", "start"]');
    expect(EDEN_EVE_DOCKERFILE).not.toContain('CMD ["node", ".output/server/index.mjs"]');
    // Not via npm exec/npm run either — unreliable SIGTERM forwarding as PID 1, and Eden's
    // scale-to-zero is a docker stop.
    expect(EDEN_EVE_DOCKERFILE).not.toMatch(/CMD.*npm (exec|run)/);
  });

  it("runtime stage inherits the build stage (eve start needs node_modules + .eve/compile)", async () => {
    const { EDEN_EVE_DOCKERFILE } = await import("~/deploy/eve-image.server");
    expect(EDEN_EVE_DOCKERFILE).toMatch(/^FROM build$/m);
    // Exactly one base-image stage: the old lean runtime stage duplicated nothing it needed.
    expect(EDEN_EVE_DOCKERFILE.match(/^FROM node:24-slim/gm)).toHaveLength(1);
    // The publish gate + world migrations build `--target build` — the stage name is API.
    expect(EDEN_EVE_DOCKERFILE).toContain("FROM node:24-slim AS build");
  });

  it("keeps the runtime contract: PORT env, exposed port, the eve-docker shim", async () => {
    const { EDEN_EVE_DOCKERFILE } = await import("~/deploy/eve-image.server");
    expect(EDEN_EVE_DOCKERFILE).toContain("ENV PORT=3000");
    expect(EDEN_EVE_DOCKERFILE).toContain("EXPOSE 3000");
    expect(EDEN_EVE_DOCKERFILE).toContain("/usr/local/bin/eve-docker");
  });
});
