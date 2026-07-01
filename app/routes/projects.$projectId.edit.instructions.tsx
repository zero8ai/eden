/**
 * Structured editor: agent instructions (Author pillar, M1).
 *
 * The simplest editor, and the proof of the git-native write flow (D3): load the current
 * `agent/instructions.md`, edit it, and Save opens a PR via `proposeChange`. Eden never writes
 * the default branch directly — the human merges the PR to ship.
 */
import { authkitLoader, withAuth } from "@workos-inc/authkit-react-router";
import {
  Form,
  Link,
  data,
  redirect,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { syncTenant } from "~/auth/tenant.server";
import { getProject } from "~/db/queries.server";
import { readAgentFile } from "~/github/repo.server";
import { proposeChange } from "~/github/write.server";
import type { Route } from "./+types/projects.$projectId.edit.instructions";

const INSTRUCTIONS_PATH = "agent/instructions.md";

export const loader = (args: LoaderFunctionArgs) =>
  authkitLoader(
    args,
    async ({ auth }) => {
      const { org } = await syncTenant({
        user: auth.user,
        organizationId: auth.organizationId,
        role: auth.role,
      });
      if (!org) throw data("No organization", { status: 403 });

      const project = await getProject(org.id, args.params.projectId!);
      if (!project) throw data("Project not found", { status: 404 });
      if (!project.repoInstallationId || !project.repoOwner || !project.repoName) {
        throw data("Project has no connected repo", { status: 400 });
      }

      const instructions =
        (await readAgentFile(
          project.repoInstallationId,
          { owner: project.repoOwner, repo: project.repoName },
          INSTRUCTIONS_PATH,
        )) ?? "";

      return { project, instructions };
    },
    { ensureSignedIn: true },
  );

export async function action(args: ActionFunctionArgs) {
  const auth = await withAuth(args);
  if (!auth.user) throw redirect("/login");

  const { org } = await syncTenant({
    user: auth.user,
    organizationId: auth.organizationId ?? null,
    role: auth.role ?? null,
  });
  if (!org) return { error: "You must belong to an organization." };

  const project = await getProject(org.id, args.params.projectId!);
  if (!project?.repoInstallationId || !project.repoOwner || !project.repoName) {
    return { error: "Project has no connected repo." };
  }

  const form = await args.request.formData();
  const content = String(form.get("content") ?? "");

  try {
    const change = await proposeChange(
      project.repoInstallationId,
      { owner: project.repoOwner, repo: project.repoName },
      {
        branch: `eden/instructions-${Date.now().toString(36)}`,
        files: [{ path: INSTRUCTIONS_PATH, content }],
        title: "Update agent instructions",
        body: "Edited via Eden.",
        commitMessage: "chore(agent): update instructions",
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

export function meta() {
  return [{ title: "Edit instructions · Eden" }];
}

export default function EditInstructions({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { project, instructions } = loaderData;
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
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          Agent instructions
        </h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Saving opens a pull request against{" "}
          <span className="font-mono">{project.defaultBranch}</span>. Merge it to
          ship.
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
          <textarea
            name="content"
            defaultValue={instructions}
            rows={20}
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
      </div>
    </main>
  );
}
