/**
 * Provider-generic OAuth broker (issue #163) — the pure shapes the generalization added on top
 * of the Google-only broker: PKCE (RFC 7636 verifier/challenge, carried through the signed
 * state), generic authorize-URL construction (authorizeParams / identityScopes / codeChallenge),
 * registry validation on verify, userinfo-less providers, and the byte-for-byte Google
 * regression the issue's acceptance criteria demand (google-connect.test.ts stays the
 * behavioral anchor; this file pins the exact URL literal).
 */
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  authorizeUrl,
  codeChallengeS256,
  exchangeCode,
  fetchAccountEmail,
  generateCodeVerifier,
  signConnectState,
  verifyConnectState,
  type ConnectState,
} from "~/connections/oauth.server";
import { googleAuthorizeUrl } from "~/connections/google.server";
import {
  getProvider,
  providerRedirectPath,
  type ProviderDefinition,
} from "~/connections/providers.server";

/** A hypothetical PKCE provider — NOT in the registry (that's part of what's under test). */
const MAYI: ProviderDefinition = {
  id: "mayi",
  label: "May I?",
  authorizeUrl: "https://auth.mayi.example/oauth/authorize",
  tokenUrl: "https://auth.mayi.example/oauth/token",
  pkce: true,
  authorizeParams: { audience: "https://api.mayi.example", access_type: "offline" },
  identityScopes: ["profile"],
  envPrefix: "MAYI",
};

const state: ConnectState = {
  projectId: "projabcdefgh",
  agentId: "agntabcdefgh",
  userId: "userabcdefgh",
  sessionId: "sessabcdefgh",
  nonce: "nonceabcdefgh",
  provider: "google",
  scopes: "https://www.googleapis.com/auth/spreadsheets",
  returnTo: "/dashboard",
  exp: 1_800_000_000_000,
};

describe("PKCE (RFC 7636)", () => {
  it("generates verifiers of exactly 43 chars from the unreserved base64url charset", () => {
    for (let i = 0; i < 32; i++) {
      // §4.1: code_verifier = 43*128unreserved; base64url of 32 random bytes is the 43-char floor.
      expect(generateCodeVerifier()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
  });

  it("derives the S256 challenge per the RFC's appendix B vector", () => {
    expect(
      codeChallengeS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    ).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("round-trips the code_verifier through the HMAC-signed state", () => {
    const key = randomBytes(32);
    const codeVerifier = generateCodeVerifier();
    const token = signConnectState({ ...state, codeVerifier }, key);
    const verified = verifyConnectState(token, key, state.exp - 1000);
    expect(verified?.codeVerifier).toBe(codeVerifier);
    // The challenge the connect route put on the authorize URL still matches what the callback
    // will send on the exchange — the round-trip loses nothing.
    expect(codeChallengeS256(verified!.codeVerifier!)).toBe(
      codeChallengeS256(codeVerifier),
    );
  });

  it("accepts the RFC length bounds (43 and 128) and rejects outside them", () => {
    const key = randomBytes(32);
    const ok = (codeVerifier: string) =>
      verifyConnectState(
        signConnectState({ ...state, codeVerifier }, key),
        key,
        state.exp - 1000,
      );
    expect(ok("a".repeat(43))).not.toBeNull();
    expect(ok("a".repeat(128))).not.toBeNull();
    expect(ok("a".repeat(42))).toBeNull();
    expect(ok("a".repeat(129))).toBeNull();
  });

  it("rejects a non-string codeVerifier while a state without one stays valid", () => {
    const key = randomBytes(32);
    const bad = signConnectState(
      { ...state, codeVerifier: 42 } as unknown as ConnectState,
      key,
    );
    expect(verifyConnectState(bad, key, state.exp - 1000)).toBeNull();
    const plain = signConnectState(state, key);
    expect(verifyConnectState(plain, key, state.exp - 1000)).toEqual(state);
  });
});

describe("verifyConnectState registry validation", () => {
  it("rejects a state whose provider is not registered (the registry is the authority)", () => {
    const key = randomBytes(32);
    const token = signConnectState({ ...state, provider: "mayi" }, key);
    expect(verifyConnectState(token, key, state.exp - 1000)).toBeNull();
  });
});

describe("authorizeUrl (generic)", () => {
  const input = {
    clientId: "client_1",
    redirectUri: "https://eden.example/connections/mayi/callback",
    state: "signed-state",
    scopes: "mayi.approvals",
  };

  it("emits params in insertion order: standard, authorizeParams, state", () => {
    const url = authorizeUrl(MAYI, input);
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(MAYI.authorizeUrl);
    expect([...parsed.searchParams.keys()]).toEqual([
      "client_id",
      "redirect_uri",
      "response_type",
      "scope",
      "audience",
      "access_type",
      "state",
    ]);
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("audience")).toBe("https://api.mayi.example");
    expect(parsed.searchParams.get("access_type")).toBe("offline");
    expect(parsed.searchParams.get("state")).toBe("signed-state");
  });

  it("appends identityScopes after the requested scopes, deduped", () => {
    const url = authorizeUrl(MAYI, input);
    expect(new URL(url).searchParams.get("scope")).toBe(
      "mayi.approvals profile",
    );
    const already = authorizeUrl(MAYI, {
      ...input,
      scopes: ["profile", "mayi.approvals"],
    });
    expect(new URL(already).searchParams.get("scope")).toBe(
      "profile mayi.approvals",
    );
  });

  it("adds code_challenge + S256 method only when a challenge is passed", () => {
    const verifier = generateCodeVerifier();
    const withPkce = new URL(
      authorizeUrl(MAYI, { ...input, codeChallenge: codeChallengeS256(verifier) }),
    );
    expect(withPkce.searchParams.get("code_challenge")).toBe(
      codeChallengeS256(verifier),
    );
    expect(withPkce.searchParams.get("code_challenge_method")).toBe("S256");

    const without = new URL(authorizeUrl(MAYI, input));
    expect(without.searchParams.has("code_challenge")).toBe(false);
    expect(without.searchParams.has("code_challenge_method")).toBe(false);
  });
});

describe("exchangeCode with PKCE", () => {
  const config = { clientId: "c", clientSecret: "s" };
  const grantBody = JSON.stringify({
    access_token: "at",
    refresh_token: "rt",
    expires_in: 3599,
    scope: "mayi.approvals",
  });

  it("sends code_verifier when supplied and omits it otherwise", async () => {
    const bodies: string[] = [];
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ""));
      return new Response(grantBody, { status: 200 });
    }) as typeof fetch;

    const verifier = generateCodeVerifier();
    await exchangeCode(
      {
        provider: MAYI,
        config,
        code: "code_1",
        redirectUri: "https://e/connections/mayi/callback",
        codeVerifier: verifier,
      },
      fetchImpl,
    );
    await exchangeCode(
      {
        provider: MAYI,
        config,
        code: "code_2",
        redirectUri: "https://e/connections/mayi/callback",
      },
      fetchImpl,
    );
    expect(new URLSearchParams(bodies[0]).get("code_verifier")).toBe(verifier);
    expect(new URLSearchParams(bodies[1]).has("code_verifier")).toBe(false);
  });

  it("names the provider label in exchange errors", async () => {
    const fetchImpl = (async () =>
      new Response("bad", { status: 400 })) as typeof fetch;
    await expect(
      exchangeCode(
        { provider: MAYI, config, code: "x", redirectUri: "https://e/cb" },
        fetchImpl,
      ),
    ).rejects.toThrow(/May I\? rejected the token exchange/);
  });
});

describe("fetchAccountEmail without a userinfo endpoint", () => {
  it("returns null with zero network calls", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect(await fetchAccountEmail(MAYI, "at", fetchImpl)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("Google-unchanged regression (issue #163 acceptance criterion 2)", () => {
  const input = {
    clientId: "client_1",
    redirectUri: "https://eden.example/google/callback",
    state: "st at e",
    scopes: "https://www.googleapis.com/auth/spreadsheets",
  };

  it("produces the Google-only broker's authorize URL byte-for-byte", () => {
    // The pre-#163 construction — insertion order and all — MINUS include_granted_scopes: issue
    // #165 removed it deliberately (Eden always requests the full effective set, and with the
    // param set Google folds previously granted scopes into every new token, so a narrowed
    // scope-group selection could never re-issue a narrower grant on reconnect).
    const expected = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams(
      {
        client_id: input.clientId,
        redirect_uri: input.redirectUri,
        response_type: "code",
        scope: `${input.scopes} openid email`,
        access_type: "offline",
        prompt: "consent",
        state: input.state,
      },
    ).toString()}`;
    expect(authorizeUrl(getProvider("google")!, input)).toBe(expected);
    // The compat shim the legacy routes/tests use emits the identical bytes.
    expect(googleAuthorizeUrl(input)).toBe(expected);
  });

  it("never re-broadens a narrowed grant via incremental auth (issue #165)", () => {
    // include_granted_scopes must stay OFF the Google authorize URL — see the registry comment.
    const url = new URL(authorizeUrl(getProvider("google")!, input));
    expect(url.searchParams.has("include_granted_scopes")).toBe(false);
  });

  it("never puts PKCE params on Google's authorize URL (google declares no pkce)", () => {
    expect(getProvider("google")!.pkce).toBeUndefined();
    const url = new URL(authorizeUrl(getProvider("google")!, input));
    expect(url.searchParams.has("code_challenge")).toBe(false);
  });

  it("keeps Google on the legacy /google/callback redirect path; new providers get the canonical one", () => {
    expect(providerRedirectPath(getProvider("google")!)).toBe(
      "/google/callback",
    );
    expect(providerRedirectPath(MAYI)).toBe("/connections/mayi/callback");
  });

  it("derives the S256 challenge with sha256/base64url (sanity against node primitives)", () => {
    const verifier = generateCodeVerifier();
    expect(codeChallengeS256(verifier)).toBe(
      createHash("sha256").update(verifier).digest("base64url"),
    );
  });
});
