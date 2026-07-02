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

/** Public URL where a user installs the App on a new org/account. */
export function getInstallUrl(state?: string): string {
  const base = `https://github.com/apps/${getGitHubConfig().slug}/installations/new`;
  return state ? `${base}?state=${encodeURIComponent(state)}` : base;
}
