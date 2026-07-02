/**
 * Generic file editor (Author pillar, M1).
 *
 * Edits (or creates) any file under `agent/` — tools, channels, schedules, connections,
 * subagents, or a raw config file. Save STAGES a draft (refresh-proof, no git write); the
 * Changes tab publishes staged drafts as one PR (PRD §7.3). The target file is the `?path=`
 * query param; a missing file is treated as a new file to create.
 *
 * This is the general-purpose companion to the labeled instructions editor: the read-only
 * agent view links every file resource here, and a "New file" form creates fresh ones.
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
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { getDraft, stageDraft } from "~/drafts/drafts.server";
import { readAgentFile } from "~/github/repo.server";
import {
  normalizeAgentPath,
  requireProject,
  requireRepo,
  type ConnectedProject,
} from "~/project/guard.server";
import type { Route } from "./+types/projects.$projectId.edit";

interface FileEditView {
  project: ConnectedProject;
  path: string | null;
  content: string;
  exists: boolean;
  hasDraft: boolean;
}

export const loader = (args: LoaderFunctionArgs) =>
  authkitLoader(
    args,
    async ({ auth }): Promise<FileEditView> => {
      const project = requireRepo(
        await requireProject(
          {
            user: auth.user,
            organizationId: auth.organizationId,
            role: auth.role,
          },
          args.params.projectId,
        ),
      );

      const raw = new URL(args.request.url).searchParams.get("path") ?? "";
      const path = normalizeAgentPath(raw);
      if (!path) {
        return { project, path: null, content: "", exists: false, hasDraft: false };
      }

      // Overlay a staged draft (unpublished edit) over the repo content.
      const [content, draft] = await Promise.all([
        readAgentFile(
          project.repoInstallationId,
          { owner: project.repoOwner, repo: project.repoName },
          path,
        ),
        getDraft(project.id, path),
      ]);
      return {
        project,
        path,
        content: draft?.content ?? content ?? "",
        exists: content !== null,
        hasDraft: !!draft,
      };
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
  const path = normalizeAgentPath(String(form.get("path") ?? ""));
  if (!path) return { error: "Invalid path — files must live under agent/." };
  const content = String(form.get("content") ?? "");

  try {
    await stageDraft({
      projectId: project.id,
      path,
      content,
      createdBy: auth.user.id,
    });
    return { ok: true as const };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

export function meta() {
  return [{ title: "Edit file · Eden" }];
}

export default function EditFile({ loaderData, actionData }: Route.ComponentProps) {
  const { project, path, content, exists, hasDraft } = loaderData;
  const navigation = useNavigation();
  const saving = navigation.state === "submitting";

  const base = `/projects/${project.id}`;

  return (
    <AppShell>
      {!path ? (
        <>
          <PageHeader
            title="New file"
            description={
              <>
                Enter a path under <span className="font-mono">agent/</span> to
                create or open a file.
              </>
            }
          />
          <AgentNav base={base} />
          <Form method="get" className="flex max-w-2xl gap-2">
            <Input
              name="path"
              defaultValue="agent/tools/"
              spellCheck={false}
              className="flex-1 font-mono text-sm"
            />
            <Button type="submit">Open</Button>
          </Form>
        </>
      ) : (
        <>
          <PageHeader
            title={
              <span className="flex items-center gap-3">
                <span className="font-mono text-xl">{path}</span>
                {!exists && <Badge variant="secondary">new</Badge>}
              </span>
            }
            description="Saving stages the change — publish staged changes as one pull request from the Changes tab."
          />
          <AgentNav base={base} />

          {actionData?.error && (
            <Alert variant="destructive" className="mb-6">
              <AlertTitle>Couldn&rsquo;t stage the change</AlertTitle>
              <AlertDescription>{actionData.error}</AlertDescription>
            </Alert>
          )}
          {(actionData?.ok || hasDraft) && (
            <Alert className="mb-6">
              <AlertTitle>Staged — not published yet</AlertTitle>
              <AlertDescription className="flex items-center gap-3">
                <span>This file has an unpublished draft.</span>
                <Link
                  to={`${base}/changes`}
                  className="font-medium underline underline-offset-4"
                >
                  Review &amp; publish in Changes →
                </Link>
              </AlertDescription>
            </Alert>
          )}

          <Form method="post">
            <input type="hidden" name="path" value={path} />
            <Textarea
              name="content"
              defaultValue={content}
              spellCheck={false}
              className="min-h-[28rem] font-mono text-sm"
            />
            <div className="mt-4 flex items-center gap-3">
              <Button type="submit" disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </Button>
              <Button variant="ghost" asChild>
                <Link to={base}>Cancel</Link>
              </Button>
            </div>
          </Form>
        </>
      )}
    </AppShell>
  );
}
