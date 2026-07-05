import { describe, expect, it, vi } from "vitest";

import {
  runWorldMigrations,
  WORLD_POSTGRES_SETUP_SCRIPT,
} from "~/seams/oss/deploy.localdocker.server";

describe("runWorldMigrations", () => {
  it("skips when the build-stage image does not contain the Workflow setup script", async () => {
    const runDocker = vi.fn(async (args: string[]) => {
      if (args[0] === "image") return "";
      if (args.includes("test")) throw new Error("missing");
      throw new Error(`unexpected docker call: ${args.join(" ")}`);
    });

    await runWorldMigrations("eden/proj-x:abc", "postgres://world", runDocker);

    expect(runDocker).toHaveBeenCalledTimes(2);
    expect(runDocker).toHaveBeenLastCalledWith([
      "run",
      "--rm",
      "eden/proj-x:abc-build",
      "test",
      "-f",
      WORLD_POSTGRES_SETUP_SCRIPT,
    ]);
  });

  it("runs the Workflow setup script when it is present", async () => {
    const runDocker = vi.fn(async () => "");

    await runWorldMigrations("eden/proj-x:abc", "postgres://world", runDocker);

    expect(runDocker).toHaveBeenLastCalledWith([
      "run",
      "--rm",
      "--add-host",
      "host.docker.internal:host-gateway",
      "-e",
      "WORKFLOW_POSTGRES_URL=postgres://world",
      "eden/proj-x:abc-build",
      "node",
      WORLD_POSTGRES_SETUP_SCRIPT,
    ]);
  });
});
