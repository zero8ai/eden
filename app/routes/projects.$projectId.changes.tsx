/**
 * Changes — the in-app review inbox (Review & version pillar, PRD §7.3).
 *
 * Every edit Eden makes lands as a pull request; this is where a PM sees those pending
 * change-sets and merges them without leaving the app ("merge in Eden or on GitHub"). Merging
 * squashes the change into one commit on the default branch and records a Release at that merge
 * SHA — the canonical version identity (§7.7). Deploying that Release is a separate, explicit
 * step on the Deployments tab (the human picks environment + traffic weight).
 */
import { authkitLoader, withAuth } from "@workos-inc/authkit-react-router";
import {
  Form,
  Link,
  redirect,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { AgentNav, AppShell, PageHeader } from "~/components/shell";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { ensureReleaseForCommit } from "~/deploy/controller.server";
import { listOpenChanges, mergePullRequest } from "~/github/write.server";
import { requireProject, requireRepo } from "~/project/guard.server";
import type { Route } from "./+types/projects.$projectId.changes";

export const loader = (args: LoaderFunctionArgs) =>
  authkitLoader(
    args,
    async ({ auth }) => {
      const project = requireRepo(
        await requireProject(
          { user: auth.user, organizationId: auth.organizationId, role: auth.role },
          args.params.projectId,
        ),
      );
      const changes = await listOpenChanges(project.repoInstallationId, {
        owner: project.repoOwner,
        repo: project.repoName,
      });
      return { project, changes };
    },
    { ensureSignedIn: true },
  );

export async function action(args: ActionFunctionArgs) {
  const auth = await withAuth(args);
  if (!auth.user) throw redirect("/login");
  const project = requireRepo(
    await requireProject(
      {
        user: auth.user,
        organizationId: auth.organizationId ?? null,
        role: auth.role ?? null,
      },
      args.params.projectId,
    ),
  );

  const form = await args.request.formData();
  const pullNumber = Number(form.get("pullNumber"));
  const branch = String(form.get("branch") ?? "") || undefined;
  const title = String(form.get("title") ?? "");
  if (!pullNumber) return { error: "Missing change to merge." };

  const repo = { owner: project.repoOwner, repo: project.repoName };
  try {
    // 1. Merge the change-set → one commit on the default branch (the version identity).
    const { mergeSha } = await mergePullRequest(
      project.repoInstallationId,
      repo,
      pullNumber,
      branch,
    );
    // 2. Record the Release at that merge commit (idempotent with the webhook path).
    const { release } = await ensureReleaseForCommit({
      projectId: project.id,
      gitSha: mergeSha,
      changelog: `#${pullNumber} ${title}`.trim(),
      createdBy: auth.user.id,
    });
    // 3. Hand off to Deployments, where the human deploys the new version at a chosen weight.
    throw redirect(
      `/projects/${project.id}/deployments?released=${encodeURIComponent(release.version)}`,
    );
  } catch (error) {
    if (error instanceof Response) throw error;
    return { error: (error as Error).message };
  }
}

export function meta() {
  return [{ title: "Changes · Eden" }];
}

export default function Changes({ loaderData, actionData }: Route.ComponentProps) {
  const { project, changes } = loaderData;
  const base = `/projects/${project.id}`;
  const navigation = useNavigation();
  const merging = navigation.state === "submitting";

  return (
    <AppShell>
      <PageHeader
        title="Changes"
        description="Pending edits to this agent, each a reviewable change-set. Merge one to turn it into a new version, then deploy it from Deployments."
      />
      <AgentNav base={base} />

      {actionData?.error && (
        <Alert variant="destructive" className="mb-6">
          <AlertTitle>Couldn&rsquo;t merge</AlertTitle>
          <AlertDescription>{actionData.error}</AlertDescription>
        </Alert>
      )}

      {changes.length === 0 ? (
        <Card className="border-dashed">
          <CardHeader className="items-center py-12 text-center">
            <CardTitle className="text-lg">No pending changes</CardTitle>
            <CardContent className="pt-2 text-sm text-muted-foreground">
              Edit the agent&rsquo;s instructions, model, or files — each save opens a
              change here, ready to review and merge.
            </CardContent>
            <Button asChild className="mt-2">
              <Link to={base}>Go to the agent</Link>
            </Button>
          </CardHeader>
        </Card>
      ) : (
        <div className="space-y-4">
          {changes.map((c) => (
            <ChangeCard key={c.number} change={c} merging={merging} />
          ))}
        </div>
      )}
    </AppShell>
  );
}

function ChangeCard({
  change,
  merging,
}: {
  change: Route.ComponentProps["loaderData"]["changes"][number];
  merging: boolean;
}) {
  const conflicted = change.mergeable === false;
  const checking = change.mergeable === null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="text-base">
              {change.title}{" "}
              <span className="font-mono text-sm font-normal text-muted-foreground">
                #{change.number}
              </span>
            </CardTitle>
            {change.body && (
              <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                {change.body}
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <MergeabilityBadge conflicted={conflicted} checking={checking} />
            <Form method="post">
              <input type="hidden" name="pullNumber" value={change.number} />
              <input type="hidden" name="branch" value={change.branch} />
              <input type="hidden" name="title" value={change.title} />
              <Button type="submit" size="sm" disabled={merging || conflicted}>
                {merging ? "Merging…" : "Merge"}
              </Button>
            </Form>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {change.files.length === 0 ? (
          <p className="text-sm text-muted-foreground">No file changes.</p>
        ) : (
          <ul className="divide-y rounded-lg border text-sm">
            {change.files.map((f) => (
              <li key={f.path} className="flex items-center justify-between gap-3 px-3 py-1.5">
                <span className="truncate font-mono text-xs">{f.path}</span>
                <span className="flex shrink-0 items-center gap-2 font-mono text-xs">
                  <span className="text-emerald-600 dark:text-emerald-400">+{f.additions}</span>
                  <span className="text-destructive">−{f.deletions}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
        {conflicted && (
          <p className="mt-3 text-xs text-destructive">
            Conflicts with the current default branch — re-save from a fresh edit to rebase it.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function MergeabilityBadge({
  conflicted,
  checking,
}: {
  conflicted: boolean;
  checking: boolean;
}) {
  if (checking) return <Badge variant="secondary">checking…</Badge>;
  if (conflicted) return <Badge variant="destructive">conflicts</Badge>;
  return <Badge variant="outline">ready</Badge>;
}
