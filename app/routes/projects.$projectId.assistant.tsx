/**
 * Embedded authoring assistant (Author pillar, M1 — PRD §7.2).
 *
 * A PM describes a tool; the assistant generates the `defineTool` TypeScript, explains it, and
 * lists any secrets it needs. "Save" ships the generated file through the PR flow (D3). Two
 * intents: `generate` (produce + preview) and `save` (open the PR).
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

import { getAuthoringAssistant } from "~/assistant/index.server";
import { proposeChange } from "~/github/write.server";
import { requireProject, requireRepo } from "~/project/guard.server";
import type { Route } from "./+types/projects.$projectId.assistant";

export const loader = (args: LoaderFunctionArgs) =>
  authkitLoader(
    args,
    async ({ auth }) => {
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
      return { project };
    },
    { ensureSignedIn: true },
  );

type ActionResult =
  | { kind: "generated"; path: string; content: string; explanation: string; secretsNeeded: string[] }
  | { kind: "saved"; pullRequestUrl: string; pullRequestNumber: number }
  | { kind: "error"; message: string };

export async function action(args: ActionFunctionArgs): Promise<ActionResult> {
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
  const intent = String(form.get("intent") ?? "generate");

  if (intent === "save") {
    const path = String(form.get("path") ?? "");
    const content = String(form.get("content") ?? "");
    if (!path || !content) return { kind: "error", message: "Nothing to save." };
    try {
      const change = await proposeChange(
        project.repoInstallationId,
        { owner: project.repoOwner, repo: project.repoName },
        {
          branch: `eden/tool-${Date.now().toString(36)}`,
          files: [{ path, content }],
          title: `Add tool ${path.split("/").pop()}`,
          body: "Generated with the Eden authoring assistant.",
          commitMessage: `feat(agent): add ${path}`,
        },
      );
      return {
        kind: "saved",
        pullRequestUrl: change.pullRequestUrl,
        pullRequestNumber: change.pullRequestNumber,
      };
    } catch (error) {
      return { kind: "error", message: (error as Error).message };
    }
  }

  const instruction = String(form.get("instruction") ?? "").trim();
  if (!instruction) return { kind: "error", message: "Describe the tool you want." };
  try {
    const tool = await getAuthoringAssistant().generateTool({ instruction });
    return {
      kind: "generated",
      path: tool.path,
      content: tool.content,
      explanation: tool.explanation,
      secretsNeeded: tool.secretsNeeded,
    };
  } catch (error) {
    return { kind: "error", message: (error as Error).message };
  }
}

export function meta() {
  return [{ title: "Assistant · Eden" }];
}

export default function Assistant({ loaderData, actionData }: Route.ComponentProps) {
  const { project } = loaderData;
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";
  const generated = actionData?.kind === "generated" ? actionData : null;

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
          Authoring assistant
        </h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Describe a tool in plain language. The assistant writes the TypeScript;
          you review it and open a pull request.
        </p>

        {actionData?.kind === "error" && (
          <p className="mt-6 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-800/60 dark:bg-red-950/40 dark:text-red-200">
            {actionData.message}
          </p>
        )}
        {actionData?.kind === "saved" && (
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
          <input type="hidden" name="intent" value="generate" />
          <textarea
            name="instruction"
            rows={3}
            placeholder="e.g. Look up an order by ID in our Postgres and return its status."
            className="w-full rounded-xl border border-gray-300 bg-white p-4 text-sm dark:border-gray-700 dark:bg-gray-900"
          />
          <button
            type="submit"
            disabled={busy}
            className="mt-3 rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
          >
            {busy ? "Generating…" : "Generate tool"}
          </button>
        </Form>

        {generated && (
          <section className="mt-8">
            <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900 dark:border-blue-900/50 dark:bg-blue-950/30 dark:text-blue-200">
              {generated.explanation}
              {generated.secretsNeeded.length > 0 && (
                <p className="mt-2">
                  Secrets needed:{" "}
                  {generated.secretsNeeded.map((s) => (
                    <code key={s} className="mr-1 rounded bg-blue-100 px-1 dark:bg-blue-900/50">
                      {s}
                    </code>
                  ))}
                  —{" "}
                  <Link className="underline" to={`/projects/${project.id}/secrets`}>
                    set them
                  </Link>
                  .
                </p>
              )}
            </div>

            <div className="mt-3 text-xs font-medium text-gray-500 dark:text-gray-400">
              {generated.path}
            </div>
            <pre className="mt-1 max-h-96 overflow-auto rounded-xl border border-gray-200 bg-gray-50 p-4 text-xs dark:border-gray-800 dark:bg-gray-900/40">
              {generated.content}
            </pre>

            <Form method="post" className="mt-3">
              <input type="hidden" name="intent" value="save" />
              <input type="hidden" name="path" value={generated.path} />
              <input type="hidden" name="content" value={generated.content} />
              <button
                type="submit"
                disabled={busy}
                className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
              >
                {busy ? "Opening PR…" : "Save as pull request"}
              </button>
            </Form>
          </section>
        )}
      </div>
    </main>
  );
}
