import { describe, expect, it } from "vitest";

import {
  formatRequestLog,
  safeRequestPath,
} from "../../server/request-log.mjs";

describe("production request logging", () => {
  it.each([
    [
      "/api/auth/reset-password/reset-secret?callbackURL=%2Freset-password",
      "/api/auth/reset-password/[redacted]",
    ],
    [
      "/reset-password?token=callback-secret&returnTo=%2Fdashboard",
      "/reset-password",
    ],
    [
      "/api/auth/verify-email?token=verification-secret&callbackURL=%2Faccept-invitation%2Finvite-secret",
      "/api/auth/verify-email",
    ],
    [
      "/accept-invitation/invite-secret?source=email",
      "/accept-invitation/[redacted]",
    ],
    ["/dashboard?tab=private", "/dashboard"],
  ])("sanitizes %s", (requestTarget, expected) => {
    expect(safeRequestPath(requestTarget)).toBe(expected);
  });

  it("formats a useful line without tokens, queries, referrers, or user agents", () => {
    const line = formatRequestLog({
      method: "GET",
      requestTarget:
        "/api/auth/reset-password/do-not-log?callbackURL=%2Freset-password",
      status: 302,
      durationMs: 12.34,
    });

    expect(line).toBe("GET /api/auth/reset-password/[redacted] 302 12.3ms");
    expect(line).not.toContain("do-not-log");
    expect(line).not.toContain("callbackURL");
  });
});
