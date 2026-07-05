/**
 * eve-docker-shim — the runtime behaviour of EVE_DOCKER_SHIM, proven WITHOUT a Docker daemon.
 *
 * We materialize the exact shim shipped in the image to a temp file and point its REAL client
 * (EVE_DOCKER_REAL) at a fake `docker` that records the argv it was exec'd with. That lets us pin
 * the whole contract the deploy pipeline depends on: a session-role `run` gets `-v` injected right
 * after the run token with every other arg in original order; template-build runs and non-run verbs
 * pass through untouched; an unset home volume is a no-op; and exit codes stream through (`exec`).
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EVE_DOCKER_SHIM } from "~/deploy/eve-image.server";

let dir: string;
let shimPath: string;
let capturePath: string;
let fakeDocker: string;
let exit7Docker: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "eve-shim-"));
  shimPath = path.join(dir, "eve-docker");
  capturePath = path.join(dir, "capture.txt");
  fakeDocker = path.join(dir, "fake-docker");
  exit7Docker = path.join(dir, "exit7-docker");

  writeFileSync(shimPath, EVE_DOCKER_SHIM);
  chmodSync(shimPath, 0o755);

  // Fake real client: record argv (one arg per line) into the capture file, then succeed.
  writeFileSync(
    fakeDocker,
    '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$EDEN_TEST_CAPTURE"\n',
  );
  chmodSync(fakeDocker, 0o755);

  // Fake real client that exits 7, to prove the shim streams the exit code through `exec`.
  writeFileSync(exit7Docker, "#!/bin/sh\nexit 7\n");
  chmodSync(exit7Docker, 0o755);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Run the shim; return the argv the fake client received. */
function runShim(args: string[], env: Record<string, string>): string[] {
  const res = spawnSync(shimPath, args, {
    env: { EDEN_TEST_CAPTURE: capturePath, EVE_DOCKER_REAL: fakeDocker, ...env },
    encoding: "utf8",
  });
  expect(res.status).toBe(0);
  return readFileSync(capturePath, "utf8").split("\n").filter((l) => l.length > 0);
}

// eve's exact session-container argv (bindings/*.ts), minus the trailing entrypoint args.
const SESSION_RUN = [
  "run",
  "-d",
  "--name",
  "sess1",
  "--label",
  "eve.sandbox=1",
  "--label",
  "eve.sandbox.role=session",
  "--workdir",
  "/workspace",
  "--entrypoint",
  "/bin/sh",
  "ghcr.io/vercel/eve:latest",
  "-c",
  "sleep 2147483647",
];

describe("eve-docker shim", () => {
  it("injects -v <vol>:/workspace/home right after run for a session-role run", () => {
    const got = runShim(SESSION_RUN, { EDEN_HOME_VOLUME: "eden-home-x" });
    expect(got.slice(0, 3)).toEqual(["run", "-v", "eden-home-x:/workspace/home"]);
    // Everything after run is preserved in original order.
    expect(got.slice(3)).toEqual(SESSION_RUN.slice(1));
  });

  it("leaves a template-build run untouched (shared templates must not capture a volume)", () => {
    const argv = [
      "run",
      "-d",
      "--name",
      "tmpl1",
      "--label",
      "eve.sandbox.role=template-build",
      "ghcr.io/vercel/eve:latest",
    ];
    expect(runShim(argv, { EDEN_HOME_VOLUME: "eden-home-x" })).toEqual(argv);
  });

  it("leaves non-run verbs untouched (start / exec / ps)", () => {
    for (const argv of [
      ["start", "sess1"],
      ["exec", "sess1", "/bin/sh", "-c", "echo hi"],
      ["ps", "-aq", "--filter", "volume=eden-home-x"],
    ]) {
      expect(runShim(argv, { EDEN_HOME_VOLUME: "eden-home-x" })).toEqual(argv);
    }
  });

  it("is a no-op when EDEN_HOME_VOLUME is empty, even for a session run", () => {
    expect(runShim(SESSION_RUN, { EDEN_HOME_VOLUME: "" })).toEqual(SESSION_RUN);
  });

  it("streams the real client's exit code through (exec, not fork)", () => {
    const res = spawnSync(shimPath, ["start", "sess1"], {
      env: { EDEN_TEST_CAPTURE: capturePath, EVE_DOCKER_REAL: exit7Docker },
      encoding: "utf8",
    });
    expect(res.status).toBe(7);
  });
});
