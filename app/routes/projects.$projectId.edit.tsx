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

  return (
    <main className="min-h-screen px-6 py-12 text-gray-900 dark:text-gray-100">
      <div className="mx-auto max-w-3xl">
        <Link
          to={`/projects/${project.id}`}
          className="text-sm font-medium uppercase tracking-widest text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"
        >
          ← {project.name}
        </Link>

        {!path ? (
          <>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight">
              New file
            </h1>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Enter a path under <span className="font-mono">agent/</span> to
              create or open a file.
            </p>
            <Form method="get" className="mt-6 flex gap-2">
              <input
                name="path"
                defaultValue="agent/tools/"
                spellCheck={false}
                className="flex-1 rounded-md border border-gray-300 bg-white px-3 py-2 font-mono text-sm dark:border-gray-700 dark:bg-gray-900"
              />
              <button
                type="submit"
                className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
              >
                Open
              </button>
            </Form>
          </>
        ) : (
          <>
            <div className="mt-2 flex items-center gap-3">
              <h1 className="text-2xl font-semibold tracking-tight">
                <span className="font-mono text-xl">{path}</span>
              </h1>
              {!exists && (
                <span className="rounded bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-950/60 dark:text-blue-300">
                  new
                </span>
              )}
            </div>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Saving opens a pull request against{" "}
              <span className="font-mono">{project.defaultBranch}</span>.
            </p>

            {actionData?.error && (
              <p className="mt-6 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-800/60 dark:bg-red-950/40 dark:text-red-200">
                {actionData.error}
              </p>
            )}
            {actionData?.ok && (
              <p className="mt-6 rounded-lg border border-green-300 bg-green-50 px-4 py-3 text-sm text-green-800 dark:border-green-800/60 dark:bg-green-950/40 dark:text-green-200">
                Pull request opened:{" "}
                <a
                  className="font-medium underline underline-offset-4"
                  href={actionData.pullRequestUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  #{actionData.pullRequestNumber}
                </a>
              </p>
            )}

            <Form method="post" className="mt-6">
              <input type="hidden" name="path" value={path} />
              <textarea
                name="content"
                defaultValue={content}
                rows={22}
                spellCheck={false}
                className="w-full rounded-xl border border-gray-300 bg-white p-4 font-mono text-sm text-gray-900 focus:border-gray-500 focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
              />
              <div className="mt-4 flex items-center gap-3">
                <button
                  type="submit"
                  disabled={saving}
                  className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
                >
                  {saving ? "Opening PR…" : "Save as pull request"}
                </button>
                <Link
                  to={`/projects/${project.id}`}
                  className="text-sm text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"
                >
                  Cancel
                </Link>
              </div>
            </Form>
          </>
        )}
      </div>
    </main>
  );
}
