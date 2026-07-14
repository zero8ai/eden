/**
 * GitHub App client (Connect pillar, M0).
 *
 * Eden authenticates to GitHub as an App: a JWT signed with the App private key mints
 * short-lived per-installation tokens. A user installs the App on their org/repos; we store
 * the `installation_id` on the project and use it to read the eve repo (D3 source of truth).
 *
 * Server-only (`.server.ts`) — the private key must never reach the client bundle. Env is
 * read lazily so the app boots without GitHub configured; the helpers throw a clear error
 * only when GitHub features are actually used.
 */
import { App } from "octokit";

export interface GitHubAppConfig {
  appId: string;
  privateKey: string;
  clientId: string;
  clientSecret: string;
  /** App slug, used to build the public install URL. */
  slug: string;
  webhookSecret?: string;
}

function readConfig(): GitHubAppConfig {
  const {
    GITHUB_APP_ID,
    GITHUB_APP_PRIVATE_KEY,
    GITHUB_APP_CLIENT_ID,
    GITHUB_APP_CLIENT_SECRET,
    GITHUB_APP_SLUG,
    GITHUB_WEBHOOK_SECRET,
  } = process.env;

  const missing = Object.entries({
    GITHUB_APP_ID,
    GITHUB_APP_PRIVATE_KEY,
    GITHUB_APP_CLIENT_ID,
    GITHUB_APP_CLIENT_SECRET,
    GITHUB_APP_SLUG,
  }).flatMap(([k, v]) => (v ? [] : [k]));

  if (missing.length) {
    throw new Error(
      `GitHub App is not configured. Missing env: ${missing.join(", ")}. ` +
        `See .env.example and register a GitHub App (Connect pillar).`,
    );
  }

  return {
    appId: GITHUB_APP_ID!,
    // Support both real newlines and \n-escaped single-line values in .env.
    privateKey: GITHUB_APP_PRIVATE_KEY!.replace(/\\n/g, "\n"),
    clientId: GITHUB_APP_CLIENT_ID!,
    clientSecret: GITHUB_APP_CLIENT_SECRET!,
    slug: GITHUB_APP_SLUG!,
    webhookSecret: GITHUB_WEBHOOK_SECRET,
  };
}

let cachedApp: App | undefined;
let cachedConfig: GitHubAppConfig | undefined;

function getGitHubConfig(): GitHubAppConfig {
  return (cachedConfig ??= readConfig());
}

/** GitHub App user-OAuth credentials; the secret remains server-only. */
export function getGitHubUserOAuthConfig(): Pick<
  GitHubAppConfig,
  "clientId" | "clientSecret"
> {
  const { clientId, clientSecret } = getGitHubConfig();
  return { clientId, clientSecret };
}

/** The App-level Octokit client (app JWT auth). */
function getGitHubApp(): App {
  if (cachedApp) return cachedApp;
  const cfg = getGitHubConfig();
  cachedApp = new App({
    appId: cfg.appId,
    privateKey: cfg.privateKey,
    oauth: { clientId: cfg.clientId, clientSecret: cfg.clientSecret },
    ...(cfg.webhookSecret ? { webhooks: { secret: cfg.webhookSecret } } : {}),
  });
  return cachedApp;
}

/** An Octokit scoped to a single installation (per-installation token). */
export function getInstallationOctokit(installationId: string | number) {
  return getGitHubApp().getInstallationOctokit(Number(installationId));
}

/**
 * Mint a short-lived installation token NARROWED to a single repo with read-only `contents`
 * scope — the credential the assistant instance uses to clone/fetch a conversation checkout.
 * Unlike `getInstallationOctokit` (full-installation
 * scope), this asks GitHub for the minimal grant so a token that transiently reaches an instance
 * can only READ the one repo it is editing. The token is never a WRITE credential and is never
 * persisted to the shared checkout volume — the caller passes it per git invocation and drops it.
 *
 * Uses the App-JWT client's `apps.createInstallationAccessToken` (the `repositories`/`permissions`
 * narrowing params only exist on that App-level endpoint, not on an already-scoped installation
 * client). Returns the raw token string and its expiry.
 */
export async function mintNarrowedReadToken(input: {
  installationId: string | number;
  /** Repo name (not owner/name) — GitHub scopes `repositories` by name within the installation. */
  repo: string;
}): Promise<{ token: string; expiresAt: string }> {
  const octokit = getGitHubApp().octokit;
  const res = await octokit.rest.apps.createInstallationAccessToken(
    narrowedReadTokenParams(input.installationId, input.repo),
  );
  return { token: res.data.token, expiresAt: res.data.expires_at };
}

/**
 * The exact `createInstallationAccessToken` params for a single-repo, contents:read grant — the
 * one place the narrowing shape is defined, extracted pure so a test can assert it without GitHub
 * credentials. Any drift here (a wider permission, more repos) is the security-relevant thing to catch.
 */
export function narrowedReadTokenParams(installationId: string | number, repo: string) {
  return {
    installation_id: Number(installationId),
    repositories: [repo],
    permissions: { contents: "read" as const },
  };
}

/**
 * The account (org or user) an installation lives on — via the App-JWT `GET
 * /app/installations/{id}` endpoint, so it works even when the installation shares zero
 * repositories (a minimal-permission install used only to create new repos).
 */
export async function getInstallationAccountLogin(
  installationId: string | number,
): Promise<string | null> {
  const octokit = getGitHubApp().octokit;
  const { data } = await octokit.rest.apps.getInstallation({
    installation_id: Number(installationId),
  });
  const account = data.account;
  return account && "login" in account ? account.login : null;
}

/** Public URL where a user installs the App on a new org/account. */
export function getInstallUrl(state?: string): string {
  const base = `https://github.com/apps/${getGitHubConfig().slug}/installations/new`;
  return state ? `${base}?state=${encodeURIComponent(state)}` : base;
}
