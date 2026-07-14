/** Secure browser handoff for installing Eden's GitHub App from the native client. */
import { createHash, randomBytes } from "node:crypto";

import { and, eq, gt, lt } from "drizzle-orm";

import { db } from "~/db/client.server";
import { githubMobileInstallationHandoffs } from "~/db/schema";
import { signState, verifyState } from "~/lib/signed-state.server";
import { decodeKey } from "~/seams/oss/secretbox";

import { getGitHubUserOAuthConfig } from "./client.server";

export const MOBILE_GITHUB_STATE_TTL_MS = 15 * 60 * 1000;
export const MOBILE_GITHUB_HANDOFF_TTL_MS = 5 * 60 * 1000;
export const MOBILE_GITHUB_REDIRECT_URI = "eden://connect";

interface MobileGithubStateBase {
  provider: "github-mobile-install";
  orgId: string;
  userId: string;
  sessionId: string;
  nonce: string;
  redirectUrl: string;
  exp: number;
}

export interface MobileGithubSetupState extends MobileGithubStateBase {
  phase: "setup";
}

export interface MobileGithubVerifyState extends MobileGithubStateBase {
  phase: "verify";
  installationId: string;
}

export type MobileGithubState =
  MobileGithubSetupState | MobileGithubVerifyState;

export function mobileGithubStateKey(): Buffer {
  return decodeKey(process.env.EDEN_SECRETS_KEY);
}

export function signMobileGithubState(
  state: MobileGithubState,
  key: Buffer = mobileGithubStateKey(),
): string {
  return signState(state, key);
}

export function verifyMobileGithubState(
  token: string,
  key: Buffer = mobileGithubStateKey(),
  now = Date.now(),
): MobileGithubState | null {
  const state = verifyState<MobileGithubState>(token, key, now);
  if (
    !state ||
    state.provider !== "github-mobile-install" ||
    (state.phase !== "setup" && state.phase !== "verify") ||
    typeof state.orgId !== "string" ||
    typeof state.userId !== "string" ||
    typeof state.sessionId !== "string" ||
    typeof state.nonce !== "string" ||
    validateMobileGithubRedirectUrl(state.redirectUrl) === null ||
    typeof state.exp !== "number"
  ) {
    return null;
  }
  if (state.phase === "verify") {
    if (!isGithubInstallationId(state.installationId)) return null;
  } else if ("installationId" in state) {
    return null;
  }
  return state;
}

export function isGithubInstallationId(value: string): boolean {
  return /^[1-9]\d*$/.test(value);
}

/**
 * Standalone/dev builds use Eden's fixed scheme. Expo Go uses an exp(s) Metro URL; permit that
 * narrow path only outside production. HTTP(S), credentials, query strings, and fragments never
 * qualify as callback targets.
 */
export function validateMobileGithubRedirectUrl(
  value: string,
  environment = process.env.NODE_ENV,
): string | null {
  if (value === MOBILE_GITHUB_REDIRECT_URI) return value;
  if (environment === "production") return null;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "exp:" && url.protocol !== "exps:") ||
      url.pathname !== "/--/connect" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function toMobileGithubVerifyState(
  setup: MobileGithubSetupState,
  installationId: string,
): MobileGithubVerifyState | null {
  if (!isGithubInstallationId(installationId)) return null;
  return { ...setup, phase: "verify", installationId };
}

export function githubUserAuthorizeUrl(input: {
  redirectUri: string;
  state: string;
}): string {
  const { clientId } = getGitHubUserOAuthConfig();
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  return url.toString();
}

export async function exchangeGithubUserCode(
  input: { code: string; redirectUri: string },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const { clientId, clientSecret } = getGitHubUserOAuthConfig();
  const response = await fetchImpl(
    "https://github.com/login/oauth/access_token",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code: input.code,
        redirect_uri: input.redirectUri,
      }),
    },
  );
  const payload = (await response.json().catch(() => null)) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  } | null;
  if (!response.ok || !payload?.access_token) {
    throw new Error(
      payload?.error_description ??
        payload?.error ??
        "GitHub did not issue a user access token.",
    );
  }
  return payload.access_token;
}

/** App-JWT access is not ownership proof; this request is authenticated as the GitHub user. */
export async function githubUserCanAccessInstallation(
  accessToken: string,
  installationId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!isGithubInstallationId(installationId)) return false;
  const response = await fetchImpl(
    `https://api.github.com/user/installations/${encodeURIComponent(installationId)}/repositories?per_page=1`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${accessToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (response.status === 403 || response.status === 404) return false;
  if (!response.ok) {
    throw new Error(
      `GitHub could not verify the installation (${response.status}).`,
    );
  }
  return true;
}

function handoffHash(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

export async function createMobileGithubHandoff(input: {
  installationId: string;
  orgId: string;
  userId: string;
  sessionId: string;
  expiresAt?: Date;
}): Promise<string> {
  if (!isGithubInstallationId(input.installationId)) {
    throw new Error("Invalid GitHub installation identifier.");
  }
  const now = new Date();
  await db
    .delete(githubMobileInstallationHandoffs)
    .where(lt(githubMobileInstallationHandoffs.expiresAt, now));
  const code = randomBytes(32).toString("base64url");
  await db.insert(githubMobileInstallationHandoffs).values({
    codeHash: handoffHash(code),
    installationId: input.installationId,
    orgId: input.orgId,
    userId: input.userId,
    sessionId: input.sessionId,
    expiresAt:
      input.expiresAt ?? new Date(Date.now() + MOBILE_GITHUB_HANDOFF_TTL_MS),
  });
  return code;
}

/** Atomically redeem only when the current native session matches every original binding. */
export async function consumeMobileGithubHandoff(input: {
  code: string;
  orgId: string;
  userId: string;
  sessionId: string;
}): Promise<string | null> {
  const deleted = await db
    .delete(githubMobileInstallationHandoffs)
    .where(
      and(
        eq(githubMobileInstallationHandoffs.codeHash, handoffHash(input.code)),
        eq(githubMobileInstallationHandoffs.orgId, input.orgId),
        eq(githubMobileInstallationHandoffs.userId, input.userId),
        eq(githubMobileInstallationHandoffs.sessionId, input.sessionId),
        gt(githubMobileInstallationHandoffs.expiresAt, new Date()),
      ),
    )
    .returning({
      installationId: githubMobileInstallationHandoffs.installationId,
    });
  return deleted[0]?.installationId ?? null;
}

/** Fixed deep-link destination; never accept a browser/client-supplied return URL. */
export function mobileGithubHandoffUrl(
  code: string,
  redirectUrl: string,
): string {
  const validated = validateMobileGithubRedirectUrl(redirectUrl);
  if (!validated) throw new Error("Invalid native GitHub callback URL.");
  const url = new URL(validated);
  url.searchParams.set("handoff", code);
  return url.toString();
}

/** Return only fixed, server-authored failures to a callback URL carried in verified state. */
export function mobileGithubErrorUrl(
  redirectUrl: string,
  code:
    "cancelled" | "expired" | "invalid_installation" | "verification_failed",
): string {
  const validated = validateMobileGithubRedirectUrl(redirectUrl);
  if (!validated) throw new Error("Invalid native GitHub callback URL.");
  const descriptions = {
    cancelled: "GitHub authorization was cancelled.",
    expired: "This GitHub authorization expired. Start again.",
    invalid_installation: "GitHub returned an invalid installation.",
    verification_failed:
      "Your GitHub account could not verify that installation.",
  } as const;
  const url = new URL(validated);
  url.searchParams.set("error", code);
  url.searchParams.set("error_description", descriptions[code]);
  return url.toString();
}
