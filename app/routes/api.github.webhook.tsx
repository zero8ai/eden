/**
 * GitHub App webhook receiver — the merge-triggers-deploy pipeline (PRD §7.3/§7.4).
 *
 * On a merged pull request, cut a Release at the merge commit and deploy it to the project's
 * production environment. Resource route (action only); signature-verified.
 */
import { eq, and } from "drizzle-orm";
import { data, type ActionFunctionArgs } from "react-router";

import { db } from "~/db/client.server";
import { environments } from "~/db/schema";
import {
  createRelease,
  deployRelease,
  findProjectByRepo,
} from "~/deploy/controller.server";
import { verifyGitHubSignature } from "~/github/webhook.server";

export async function action({ request }: ActionFunctionArgs) {
  const raw = await request.text();
  if (!verifyGitHubSignature(raw, request.headers.get("x-hub-signature-256"))) {
    throw data("invalid signature", { status: 401 });
  }

  const event = request.headers.get("x-github-event");
  const payload = JSON.parse(raw) as {
    action?: string;
    pull_request?: { merged?: boolean; merge_commit_sha?: string; title?: string; number?: number };
    repository?: { name?: string; owner?: { login?: string } };
  };

  // Only act on merged PRs.
  if (
    event !== "pull_request" ||
    payload.action !== "closed" ||
    !payload.pull_request?.merged ||
    !payload.pull_request.merge_commit_sha ||
    !payload.repository?.name ||
    !payload.repository.owner?.login
  ) {
    return data({ ok: true, skipped: true });
  }

  const project = await findProjectByRepo(
    payload.repository.owner.login,
    payload.repository.name,
  );
  if (!project) return data({ ok: true, skipped: "no project" });

  const release = await createRelease({
    projectId: project.id,
    gitSha: payload.pull_request.merge_commit_sha,
    changelog: payload.pull_request.title
      ? `#${payload.pull_request.number} ${payload.pull_request.title}`
      : null,
  });

  // Deploy to the production environment if one exists.
  const [prod] = await db
    .select()
    .from(environments)
    .where(and(eq(environments.projectId, project.id), eq(environments.name, "production")))
    .limit(1);
  if (prod) {
    await deployRelease({ environmentId: prod.id, releaseId: release.id });
  }

  return data({ ok: true, release: release.version });
}
