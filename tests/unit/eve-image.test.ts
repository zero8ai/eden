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
