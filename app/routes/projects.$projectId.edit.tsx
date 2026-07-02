/**
 * Generic file editor (Author pillar, M1).
 *
 * Edits (or creates) any file under `agent/` — tools, channels, schedules, connections,
 * subagents, or a raw config file — and Save opens a PR via `proposeChange` (D3). The target
 * file is the `?path=` query param; a missing file is treated as a new file to create.
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
import { readAgentFile } from "~/github/repo.server";
import { proposeChange } from "~/github/write.server";
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
        return { project, path: null, content: "", exists: false };
      }

      const content = await readAgentFile(
        project.repoInstallationId,
        { owner: project.repoOwner, repo: project.repoName },
        path,
      );
      return { project, path, content: content ?? "", exists: content !== null };
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
    const change = await proposeChange(
      project.repoInstallationId,
      { owner: project.repoOwner, repo: project.repoName },
      {
        branch: `eden/edit-${branchSlug(path)}-${Date.now().toString(36)}`,
        files: [{ path, content }],
        title: `Update ${path}`,
        body: "Edited via Eden.",
        commitMessage: `chore(agent): update ${path}`,
      },
    );
    return {
      ok: true as const,
      pullRequestUrl: change.pullRequestUrl,
      pullRequestNumber: change.pullRequestNumber,
    };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

function branchSlug(path: string): string {
  return path.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

export function meta() {
  return [{ title: "Edit file · Eden" }];
}

export default function EditFile({ loaderData, actionData }: Route.ComponentProps) {
  const { project, path, content, exists } = loaderData;
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
            description={
              <>
                Saving opens a pull request against{" "}
                <span className="font-mono">{project.defaultBranch}</span>.
              </>
            }
          />
          <AgentNav base={base} />

          {actionData?.error && (
            <Alert variant="destructive" className="mb-6">
              <AlertTitle>Couldn&rsquo;t open the change</AlertTitle>
              <AlertDescription>{actionData.error}</AlertDescription>
            </Alert>
          )}
          {actionData?.ok && (
            <Alert className="mb-6">
              <AlertTitle>Change #{actionData.pullRequestNumber} ready to review</AlertTitle>
              <AlertDescription>
                <Link
                  to={`${base}/changes`}
                  className="font-medium underline underline-offset-4"
                >
                  Review &amp; merge in Changes →
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
                {saving ? "Opening PR…" : "Save as pull request"}
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
