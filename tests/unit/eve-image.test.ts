/**
 * The generated agent Dockerfile — the contract the deploy pipeline bakes into every image.
 *
 * Pins the fix for the sandbox-template bug: images must boot via `eve start` (which prewarms
 * `eve-sbx-tpl-*` template images BEFORE the server binds its port) from a runtime stage that
 * inherits the full build stage (`eve start` needs node_modules + .eve/compile). Booting the
 * raw Nitro entry left every skills/bootstrap-carrying agent permanently unable to use its
 * bash tools (SandboxTemplateNotProvisionedError; self-heal is disabled for built servers).
 */
import { describe, expect, it } from "vitest";

import { EDEN_EVE_DOCKERFILE } from "~/deploy/eve-image.server";

describe("EDEN_EVE_DOCKERFILE", () => {
  it("boots via the eve bin (`eve start`), not the raw Nitro entry", () => {
    expect(EDEN_EVE_DOCKERFILE).toContain('CMD ["node_modules/.bin/eve", "start"]');
    expect(EDEN_EVE_DOCKERFILE).not.toContain('CMD ["node", ".output/server/index.mjs"]');
    // Not via npm exec/npm run either — unreliable SIGTERM forwarding as PID 1, and Eden's
    // scale-to-zero is a docker stop.
    expect(EDEN_EVE_DOCKERFILE).not.toMatch(/CMD.*npm (exec|run)/);
  });

  it("runtime stage inherits the build stage (eve start needs node_modules + .eve/compile)", () => {
    expect(EDEN_EVE_DOCKERFILE).toMatch(/^FROM build$/m);
    // Exactly one base-image stage: the old lean runtime stage duplicated nothing it needed.
    expect(EDEN_EVE_DOCKERFILE.match(/^FROM node:24-slim/gm)).toHaveLength(1);
    // The publish gate + world migrations build `--target build` — the stage name is API.
    expect(EDEN_EVE_DOCKERFILE).toContain("FROM node:24-slim AS build");
  });

  it("keeps the runtime contract: PORT env, exposed port, the eve-docker shim", () => {
    expect(EDEN_EVE_DOCKERFILE).toContain("ENV PORT=3000");
    expect(EDEN_EVE_DOCKERFILE).toContain("EXPOSE 3000");
    expect(EDEN_EVE_DOCKERFILE).toContain("/usr/local/bin/eve-docker");
  });
});
