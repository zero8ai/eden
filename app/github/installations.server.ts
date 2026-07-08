/**
 * Persisted GitHub App installations per tenant (Connect pillar). The install redirect is the
 * only place GitHub tells us the installation id — remember it, so /connect renders the repo
 * picker on every later visit instead of asking to "install" an app that's already installed.
 */
import { and, desc, eq } from "drizzle-orm";

import { db } from "~/db/client.server";
import { githubInstallations } from "~/db/schema";
import { getInstallationAccountLogin } from "./client.server";

export interface KnownInstallation {
  installationId: string;
  accountLogin: string | null;
}

/** Remember an installation for the org (idempotent), resolving its account for display. */
export async function rememberInstallation(
  orgId: string,
  installationId: string,
): Promise<void> {
  let accountLogin: string | null = null;
  try {
    // App-level lookup, not "first shared repo's owner" — a zero-repo (minimal-permission)
    // install has no repos to infer from but still has an account.
    accountLogin = await getInstallationAccountLogin(installationId);
  } catch {
    // Display metadata only — never block the connect flow on it.
  }
  await db
    .insert(githubInstallations)
    .values({ orgId, installationId, accountLogin })
    .onConflictDoUpdate({
      target: [githubInstallations.orgId, githubInstallations.installationId],
      set: { accountLogin },
    });
}

/** The org's known installations, newest first. */
export async function listKnownInstallations(orgId: string): Promise<KnownInstallation[]> {
  const rows = await db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.orgId, orgId))
    .orderBy(desc(githubInstallations.createdAt));
  return rows.map((r) => ({
    installationId: r.installationId,
    accountLogin: r.accountLogin,
  }));
}

/** Drop an installation that GitHub reports gone (uninstalled/suspended). */
export async function forgetInstallation(
  orgId: string,
  installationId: string,
): Promise<void> {
  await db
    .delete(githubInstallations)
    .where(
      and(
        eq(githubInstallations.orgId, orgId),
        eq(githubInstallations.installationId, installationId),
      ),
    );
}
