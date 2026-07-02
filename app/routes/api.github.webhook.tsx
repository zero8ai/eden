/**
 * GitHub App webhook receiver — keeps Eden's Release history in sync when a change is merged
 * on github.com instead of in-app (PRD §7.3: "merge in Eden or on GitHub").
 *
 * On a PR merged into the default branch, find-or-create the Release at the merge commit. It
 * does NOT auto-deploy: deploying a version is a separate, explicit act on the Deployments tab
 * (the human picks environment + traffic weight — the multi-version primitive, §7.7). The
 * release create is idempotent with the in-app Merge button via `ensureReleaseForCommit`, so a
 * change merged in Eden and echoed back by this webhook yields exactly one Release.
 * Resource route (action only); signature-verified.
 */
import { data, type ActionFunctionArgs } from "react-router";

import { ensureReleaseForCommit, findProjectByRepo } from "~/deploy/controller.server";
import { verifyGitHubSignature } from "~/github/webhook.server";

export async function action({ request }: ActionFunctionArgs) {
  const raw = await request.text();
  if (!verifyGitHubSignature(raw, request.headers.get("x-hub-signature-256"))) {
    throw data("invalid signature", { status: 401 });
  }

  const event = request.headers.get("x-github-event");
  const payload = JSON.parse(raw) as {
    action?: string;
    pull_request?: {
      merged?: boolean;
      merge_commit_sha?: string;
      title?: string;
      number?: number;
      base?: { ref?: string };
    };
    repository?: { name?: string; owner?: { login?: string }; default_branch?: string };
  };

  // Only act on PRs merged into the default branch — a merge into a feature branch is not
  // a ship signal (PRD §7.3: merge-to-mainline = deploy).
  if (
    event !== "pull_request" ||
    payload.action !== "closed" ||
    !payload.pull_request?.merged ||
    !payload.pull_request.merge_commit_sha ||
    !payload.repository?.name ||
    !payload.repository.owner?.login ||
    payload.pull_request.base?.ref !== payload.repository.default_branch
  ) {
    return data({ ok: true, skipped: true });
  }

  const project = await findProjectByRepo(
    payload.repository.owner.login,
    payload.repository.name,
  );
  if (!project) return data({ ok: true, skipped: "no project" });

  const { release, created } = await ensureReleaseForCommit({
    projectId: project.id,
    gitSha: payload.pull_request.merge_commit_sha,
    changelog: payload.pull_request.title
      ? `#${payload.pull_request.number} ${payload.pull_request.title}`
      : null,
  });

  return data({ ok: true, release: release.version, created });
}
