/**
 * Per-agent GitHub App Manifest flow (issue #26) — the pure shapes.
 *
 * The manifest literal is the App's entire grant: any drift here (a wider permission, an
 * extra event) is the security-relevant thing to catch. The state token is what binds a
 * GitHub redirect back to (project, agent, environment) — tampering and expiry must fail
 * closed. Conflict detection is what keeps two agents from sharing one @mention identity.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  GITHUB_APP_NAME_MAX,
  buildAppManifest,
  defaultAppName,
  findAppCredentialConflict,
  findStoredAppCredentialConflict,
  manifestSubmitUrl,
  signManifestState,
  verifyManifestState,
  type AppCredentialRow,
  type ManifestState,
} from "~/github/app-manifest.server";
import { fingerprint } from "~/seams/oss/secretbox";

describe("buildAppManifest", () => {
  it("emits exactly the channel's grant — nothing wider", () => {
    const manifest = buildAppManifest({
      name: "triage-acme",
      homepageUrl: "https://eden.example/repos/p1/deployment",
      webhookUrl: "https://eden.example/e/envabcdefghij/eve/v1/github",
      redirectUrl: "https://eden.example/github/apps/callback",
      setupUrl: "https://eden.example/repos/p1/deployment",
      description: "triage — an Eden agent.",
    });
    expect(manifest).toEqual({
      name: "triage-acme",
      url: "https://eden.example/repos/p1/deployment",
      hook_attributes: {
        url: "https://eden.example/e/envabcdefghij/eve/v1/github",
        active: true,
      },
      redirect_url: "https://eden.example/github/apps/callback",
      setup_url: "https://eden.example/repos/p1/deployment",
      description: "triage — an Eden agent.",
      public: false,
      default_permissions: {
        metadata: "read",
        contents: "write",
        issues: "write",
        pull_requests: "write",
      },
      default_events: ["issue_comment", "pull_request_review_comment"],
    });
  });

  it("publicApp flips ONLY GitHub's public flag (multi-account installs), nothing in the grant", () => {
    const input = {
      name: "triage-acme",
      homepageUrl: "https://eden.example/repos/p1/deployment",
      webhookUrl: "https://eden.example/e/envabcdefghij/eve/v1/github",
      redirectUrl: "https://eden.example/github/apps/callback",
      setupUrl: "https://eden.example/repos/p1/deployment",
      description: "triage — an Eden agent.",
    };
    const privateApp = buildAppManifest(input);
    const publicApp = buildAppManifest({ ...input, publicApp: true });
    expect(publicApp).toEqual({ ...privateApp, public: true });
  });
});

describe("defaultAppName", () => {
  it("joins agent and project slug", () => {
    expect(defaultAppName("triage", "acme")).toBe("triage-acme");
  });

  it("caps at GitHub's 34-char limit without a trailing hyphen", () => {
    const name = defaultAppName("a-rather-long-agent-name", "an-even-longer-project-slug");
    expect(name.length).toBeLessThanOrEqual(GITHUB_APP_NAME_MAX);
    expect(name.endsWith("-")).toBe(false);
  });

  it("sanitizes characters GitHub rejects", () => {
    expect(defaultAppName("triage@bot!", "acme co")).toBe("triage-bot-acme co");
  });

  it("works without a project slug", () => {
    expect(defaultAppName("triage", null)).toBe("triage");
  });
});

describe("manifestSubmitUrl", () => {
  it("targets the personal form by default and the org form when named", () => {
    expect(manifestSubmitUrl("tok")).toBe("https://github.com/settings/apps/new?state=tok");
    expect(manifestSubmitUrl("tok", "acme")).toBe(
      "https://github.com/organizations/acme/settings/apps/new?state=tok",
    );
  });
});

describe("manifest state token", () => {
  const key = randomBytes(32);
  const state: ManifestState = {
    projectId: "projabcdefgh",
    agentId: "agntabcdefgh",
    environmentId: "envabcdefghi",
    exp: 1_800_000_000_000,
  };

  it("round-trips a signed state", () => {
    const token = signManifestState(state, key);
    expect(verifyManifestState(token, key, state.exp - 1000)).toEqual(state);
  });

  it("rejects a tampered payload", () => {
    const token = signManifestState(state, key);
    const [payload, sig] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...state, agentId: "someoneelse1" }),
      "utf8",
    ).toString("base64url");
    expect(verifyManifestState(`${forged}.${sig}`, key, state.exp - 1000)).toBeNull();
    expect(verifyManifestState(`${payload}.AAAA`, key, state.exp - 1000)).toBeNull();
  });

  it("rejects the wrong key", () => {
    const token = signManifestState(state, key);
    expect(verifyManifestState(token, randomBytes(32), state.exp - 1000)).toBeNull();
  });

  it("rejects an expired token", () => {
    const token = signManifestState(state, key);
    expect(verifyManifestState(token, key, state.exp)).toBeNull();
    expect(verifyManifestState(token, key, state.exp + 1)).toBeNull();
  });

  it("rejects malformed input without throwing", () => {
    expect(verifyManifestState("", key)).toBeNull();
    expect(verifyManifestState("no-dot", key)).toBeNull();
    expect(verifyManifestState("a.b.c", key)).toBeNull();
  });
});

describe("app credential conflicts", () => {
  const rows: AppCredentialRow[] = [
    {
      agentId: "agent-a",
      agentName: "triage",
      key: "GITHUB_APP_SLUG",
      fingerprint: fingerprint("triage-bot"),
    },
    {
      agentId: "agent-a",
      agentName: "triage",
      key: "GITHUB_APP_ID",
      fingerprint: fingerprint("12345"),
    },
    {
      agentId: "agent-b",
      agentName: "engineer",
      key: "GITHUB_APP_SLUG",
      fingerprint: fingerprint("engineer-bot"),
    },
  ];

  it("flags another agent already holding the slug", () => {
    expect(
      findAppCredentialConflict(rows, "agent-b", { slug: "triage-bot" }),
    ).toEqual({ agentName: "triage", key: "GITHUB_APP_SLUG" });
  });

  it("flags another agent already holding the App ID", () => {
    expect(findAppCredentialConflict(rows, null, { appId: "12345" })).toEqual({
      agentName: "triage",
      key: "GITHUB_APP_ID",
    });
  });

  it("never flags the agent's own credentials (re-install/update)", () => {
    expect(
      findAppCredentialConflict(rows, "agent-a", {
        slug: "triage-bot",
        appId: "12345",
      }),
    ).toBeNull();
  });

  it("passes fresh values, empty inputs, and value-less rows", () => {
    expect(findAppCredentialConflict(rows, null, { slug: "brand-new" })).toBeNull();
    expect(findAppCredentialConflict(rows, null, {})).toBeNull();
    expect(
      findAppCredentialConflict(
        [{ agentId: "x", agentName: "x", key: "GITHUB_APP_SLUG", fingerprint: null }],
        null,
        { slug: "anything" },
      ),
    ).toBeNull();
  });

  it("detects two agents storing the same slug at deploy time", () => {
    const dup: AppCredentialRow[] = [
      ...rows,
      {
        agentId: "agent-c",
        agentName: "reviewer",
        key: "GITHUB_APP_SLUG",
        fingerprint: fingerprint("triage-bot"),
      },
    ];
    expect(findStoredAppCredentialConflict(dup, "agent-c")).toEqual({
      agentName: "triage",
      key: "GITHUB_APP_SLUG",
    });
    expect(findStoredAppCredentialConflict(rows, "agent-a")).toBeNull();
  });
});
