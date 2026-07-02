/**
 * Changes — staging area + review inbox (Review & version pillar, PRD §7.3).
 *
 * Two stages, mirroring git's own model:
 *  1. STAGED CHANGES — drafts saved from any editor (Postgres-persisted, refresh-proof).
 *     Checkbox per file; Publish turns the selected ones into ONE branch + ONE pull request
 *     (unchecked drafts stay staged). Discard drops a draft.
 *  2. OPEN CHANGE REQUESTS — published PRs awaiting review. Merge (in-app) squashes the
 *     change-set into one commit on the default branch and records a Release at that merge
 *     SHA — the canonical version identity (§7.7). Deploying is a separate act on Deployments.
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
import { Input } from "~/components/ui/input";
import { ensureReleaseForCommit } from "~/deploy/controller.server";
import { discardDrafts, listDrafts, publishDrafts } from "~/drafts/drafts.server";
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
      const [drafts, changes] = await Promise.all([
        listDrafts(project.id),
        listOpenChanges(project.repoInstallationId, {
          owner: project.repoOwner,
          repo: project.repoName,
        }),
      ]);
      return { project, drafts, changes };
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
  const intent = String(form.get("intent") ?? "");
  const back = `/projects/${project.id}/changes`;

  try {
    // ── Publish the checked drafts as one PR ──
    if (intent === "publish") {
      const paths = form.getAll("path").map(String);
      const title = String(form.get("title") ?? "");
      await publishDrafts({
        project,
        paths,
        title,
        createdBy: auth.user.id,
      });
      throw redirect(back);
    }

    // ── Discard one staged draft ──
    if (intent === "discard") {
      await discardDrafts(project.id, [String(form.get("path"))]);
      throw redirect(back);
    }

    // ── Merge an open change request ──
    if (intent === "merge") {
      const pullNumber = Number(form.get("pullNumber"));
      const branch = String(form.get("branch") ?? "") || undefined;
      const title = String(form.get("title") ?? "");
      if (!pullNumber) return { error: "Missing change to merge." };

      const repo = { owner: project.repoOwner, repo: project.repoName };
      // 1. Merge → one commit on the default branch (the version identity).
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
      // 3. Hand off to Deployments, where the human deploys the version at a chosen weight.
      throw redirect(
        `/projects/${project.id}/deployments?released=${encodeURIComponent(release.version)}`,
      );
    }

    return { error: "Unknown action." };
  } catch (error) {
    if (error instanceof Response) throw error;
    return { error: (error as Error).message };
  }
}

export function meta() {
  return [{ title: "Changes · Eden" }];
}

export default function Changes({ loaderData, actionData }: Route.ComponentProps) {
  const { project, drafts, changes } = loaderData;
  const base = `/projects/${project.id}`;
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";

  return (
    <AppShell>
      <PageHeader
        title="Changes"
        description="Staged edits publish together as one change request; merging a change request cuts a new version."
      />
      <AgentNav base={base} />

      {actionData?.error && (
        <Alert variant="destructive" className="mb-6">
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription>{actionData.error}</AlertDescription>
        </Alert>
      )}

      {/* ── Stage 1: staged (unpublished) drafts ── */}
      <Card className="mb-6">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <CardTitle className="text-base">Staged changes</CardTitle>
            <Badge variant="secondary">{drafts.length}</Badge>
          </div>
        </CardHeader>
        <CardContent>
          {drafts.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing staged. Edits you save — instructions, model, any agent file —
              collect here until you publish them together.
            </p>
          ) : (
            <>
              {/* Standalone discard form; per-row buttons reference it via form= and carry
                  the path as their own name/value (only the submitter's pair is sent). */}
              <Form method="post" id="discard-form">
                <input type="hidden" name="intent" value="discard" />
              </Form>
              <Form method="post">
                <input type="hidden" name="intent" value="publish" />
                <ul className="divide-y rounded-lg border text-sm">
                  {drafts.map((d) => (
                    <li key={d.id} className="flex items-center gap-3 px-3 py-2">
                      <input
                        type="checkbox"
                        name="path"
                        value={d.path}
                        defaultChecked
                        className="size-4 accent-primary"
                        aria-label={`Include ${d.path}`}
                      />
                      <Link
                        to={`${base}/edit?path=${encodeURIComponent(d.path)}`}
                        className="min-w-0 flex-1 truncate font-mono text-xs underline-offset-4 hover:underline"
                      >
                        {d.path}
                      </Link>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {new Date(d.updatedAt).toLocaleString()}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        type="submit"
                        form="discard-form"
                        name="path"
                        value={d.path}
                        disabled={busy}
                      >
                        Discard
                      </Button>
                    </li>
                  ))}
                </ul>
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <Input
                    name="title"
                    placeholder="Change title (optional)"
                    className="h-9 w-72"
                  />
                  <Button type="submit" disabled={busy}>
                    {busy ? "Publishing…" : "Publish selected as change request"}
                  </Button>
                </div>
              </Form>
            </>
          )}
        </CardContent>
      </Card>

      {/* ── Stage 2: open (published) change requests ── */}
      <h2 className="mb-3 text-lg font-semibold">Open change requests</h2>
      {changes.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No open change requests. Publish staged changes to create one.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {changes.map((c) => (
            <ChangeCard key={c.number} change={c} merging={busy} />
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
              <input type="hidden" name="intent" value="merge" />
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
            Conflicts with the current default branch — re-stage the files from a fresh edit.
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
