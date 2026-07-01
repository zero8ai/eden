/**
 * Structured editor: agent runtime config (`agent/agent.ts`) — Author pillar, M1.
 *
 * A form over the `defineAgent({...})` config (model to start; more options later). Save
 * rewrites `agent.ts` with a targeted edit and opens a PR (D3). If `agent.ts` doesn't exist,
 * we scaffold a minimal one.
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

import { readModel, scaffoldAgentModule, setModel, SUGGESTED_MODELS } from "~/eve/agentModule";
import { readAgentFile } from "~/github/repo.server";
import { proposeChange } from "~/github/write.server";
import { requireProject, requireRepo } from "~/project/guard.server";
import type { Route } from "./+types/projects.$projectId.edit.agent";

const AGENT_PATH = "agent/agent.ts";

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
      const source = await readAgentFile(
        project.repoInstallationId,
        { owner: project.repoOwner, repo: project.repoName },
        AGENT_PATH,
      );
      return {
        project,
        model: source ? readModel(source) : null,
        exists: source !== null,
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
  const selected = String(form.get("model") ?? "").trim();
  const model =
    selected === "__custom"
      ? String(form.get("customModel") ?? "").trim()
      : selected;
  if (!model) return { error: "Pick or enter a model." };

  const current = await readAgentFile(
    project.repoInstallationId,
    { owner: project.repoOwner, repo: project.repoName },
    AGENT_PATH,
  );
  const next = current ? setModel(current, model) : scaffoldAgentModule(model);

  try {
    const change = await proposeChange(
      project.repoInstallationId,
      { owner: project.repoOwner, repo: project.repoName },
      {
        branch: `eden/agent-config-${Date.now().toString(36)}`,
        files: [{ path: AGENT_PATH, content: next }],
        title: "Update agent runtime config",
        body: `Set model to \`${model}\` via Eden.`,
        commitMessage: "chore(agent): update runtime config",
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
  return [{ title: "Runtime config · Eden" }];
}

export default function EditAgent({ loaderData, actionData }: Route.ComponentProps) {
  const { project, model, exists } = loaderData;
  const navigation = useNavigation();
  const saving = navigation.state === "submitting";
  const current = model ?? "";
  const knownSelected = SUGGESTED_MODELS.includes(
    current as (typeof SUGGESTED_MODELS)[number],
  );

  return (
    <main className="min-h-screen px-6 py-12 text-gray-900 dark:text-gray-100">
      <div className="mx-auto max-w-2xl">
        <Link
          to={`/projects/${project.id}`}
          className="text-sm font-medium uppercase tracking-widest text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"
        >
          ← {project.name}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          Runtime config
        </h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          {exists ? (
            <>
              Editing <span className="font-mono">agent/agent.ts</span>.
            </>
          ) : (
            <>
              No <span className="font-mono">agent/agent.ts</span> yet — saving
              scaffolds one.
            </>
          )}{" "}
          Save opens a pull request.
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

        <Form method="post" className="mt-6 space-y-4">
          <div>
            <label className="block text-sm font-medium">Model</label>
            <select
              name="model"
              defaultValue={knownSelected ? current : "__custom"}
              className="mt-1 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
              onChange={(e) => {
                const custom = e.currentTarget.form?.elements.namedItem(
                  "customModel",
                ) as HTMLInputElement | null;
                if (custom) custom.hidden = e.currentTarget.value !== "__custom";
              }}
            >
              {SUGGESTED_MODELS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
              <option value="__custom">Custom…</option>
            </select>
            <input
              name="customModel"
              defaultValue={knownSelected ? "" : current}
              hidden={knownSelected}
              placeholder="provider/model-id"
              className="mt-2 w-full rounded-md border border-gray-300 bg-white px-3 py-2 font-mono text-sm dark:border-gray-700 dark:bg-gray-900"
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Provider-prefixed, e.g.{" "}
              <span className="font-mono">anthropic/claude-sonnet-5</span>.
            </p>
          </div>

          <div className="flex items-center gap-3">
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
