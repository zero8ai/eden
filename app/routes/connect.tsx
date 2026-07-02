/**
 * Connect pillar (M0): install the GitHub App, pick an eve repo, create a project.
 *
 * Flow:
 *  1. No installation yet -> show "Install on GitHub" (App install URL, org id in `state`).
 *  2. GitHub redirects back here with `?installation_id=...` -> list that installation's repos.
 *  3. User submits a repo -> validate it's an eve repo (`agent/` present) -> create project ->
 *     redirect to its read-only view.
 *
 * Set the GitHub App's "Setup URL" to `<host>/connect` so step 2 lands here.
 */
import {
  authkitLoader,
  withAuth,
} from "@workos-inc/authkit-react-router";
import {
  Form,
  Link,
  redirect,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { createProject } from "~/db/queries.server";
import { syncTenant, type Org } from "~/auth/tenant.server";
import { ensureWorkspace } from "~/auth/workspace.server";
import { getInstallUrl } from "~/github/client.server";
import { createEveRepo } from "~/github/create.server";
import {
  fetchAgentSource,
  listInstallationRepos,
  type InstallationRepo,
} from "~/github/repo.server";
import { isEveRepo } from "~/eve/parse";
import type { Route } from "./+types/connect";

type GithubConnectState =
  | { state: "no-org" }
  | { state: "install"; installUrl: string }
  | { state: "pick"; installationId: string; repos: InstallationRepo[] }
  | { state: "unconfigured"; message: string };

interface ConnectView {
  org: Org | null;
  github: GithubConnectState;
}

export const loader = (args: LoaderFunctionArgs) =>
  authkitLoader(
    args,
    async ({ auth }): Promise<ConnectView> => {
      // First org-less login: provision the user's workspace and replay (redirect).
      await ensureWorkspace(args.request, auth);
      const { org } = await syncTenant({
        user: auth.user,
        organizationId: auth.organizationId,
        role: auth.role,
      });
      if (!org) return { org: null, github: { state: "no-org" as const } };

      const url = new URL(args.request.url);
      const installationId = url.searchParams.get("installation_id");

      try {
        if (installationId) {
          const repos = await listInstallationRepos(installationId);
          return {
            org,
            github: { state: "pick" as const, installationId, repos },
          };
        }
        return {
          org,
          github: { state: "install" as const, installUrl: getInstallUrl(org.id) },
        };
      } catch (error) {
        return {
          org,
          github: {
            state: "unconfigured" as const,
            message: (error as Error).message,
          },
        };
      }
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
  if (!org) return { error: "You must belong to an organization to connect a repo." };

  const form = await args.request.formData();
  const installationId = String(form.get("installationId") ?? "");
  if (!installationId) return { error: "Missing installation." };
  const intent = String(form.get("intent") ?? "connect");

  // ── Create a new repo + scaffold (eve init) ──
  if (intent === "create") {
    const owner = String(form.get("owner") ?? "").trim();
    const name = String(form.get("name") ?? "").trim();
    if (!owner || !name) return { error: "Owner and repo name are required." };
    try {
      const repo = await createEveRepo(installationId, { owner, name });
      const project = await createProject({
        orgId: org.id,
        name,
        repoOwner: repo.owner,
        repoName: repo.repo,
        repoInstallationId: installationId,
        defaultBranch: repo.defaultBranch,
      });
      throw redirect(`/projects/${project.id}`);
    } catch (error) {
      if (error instanceof Response) throw error;
      return { error: (error as Error).message };
    }
  }

  // ── Connect an existing repo ──
  const owner = String(form.get("owner") ?? "");
  const repo = String(form.get("repo") ?? "");
  const defaultBranch = String(form.get("defaultBranch") ?? "main");
  if (!owner || !repo) return { error: "Missing repo selection." };

  // Validate it's an eve project before we persist anything.
  let source;
  try {
    source = await fetchAgentSource(installationId, { owner, repo });
  } catch (error) {
    return { error: `Could not read ${owner}/${repo}: ${(error as Error).message}` };
  }
  if (!isEveRepo(source.paths)) {
    return {
      error: `${owner}/${repo} doesn't look like an eve project — no \`agent/\` directory found.`,
    };
  }

  const project = await createProject({
    orgId: org.id,
    name: repo,
    repoOwner: owner,
    repoName: repo,
    repoInstallationId: installationId,
    defaultBranch: source.ref || defaultBranch,
  });

  throw redirect(`/projects/${project.id}`);
}

export function meta() {
  return [{ title: "Connect a repo · Eden" }];
}

export default function Connect({ loaderData, actionData }: Route.ComponentProps) {
  const { org, github } = loaderData;
  const navigation = useNavigation();
  const submitting = navigation.state === "submitting";

  return (
    <main className="min-h-screen px-6 py-12 text-gray-900 dark:text-gray-100">
      <div className="mx-auto max-w-3xl">
        <Link
          to="/dashboard"
          className="text-sm font-medium uppercase tracking-widest text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"
        >
          ← Dashboard
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          Connect an eve repo
        </h1>

        {actionData?.error && (
          <p className="mt-6 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-800/60 dark:bg-red-950/40 dark:text-red-200">
            {actionData.error}
          </p>
        )}

        {!org && (
          <p className="mt-6 text-sm text-gray-600 dark:text-gray-300">
            You need to belong to an organization first.
          </p>
        )}

        {github.state === "unconfigured" && (
          <div className="mt-6 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-200">
            <p className="font-medium">GitHub App isn&rsquo;t configured yet.</p>
            <p className="mt-1 opacity-80">{github.message}</p>
          </div>
        )}

        {github.state === "install" && (
          <div className="mt-6">
            <p className="text-sm text-gray-600 dark:text-gray-300">
              Install the Eden GitHub App on the account that owns your eve repo,
              then pick the repo to connect.
            </p>
            <a
              href={github.installUrl}
              className="mt-4 inline-block rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
            >
              Install on GitHub
            </a>
          </div>
        )}

        {github.state === "pick" && (
          <div className="mt-6">
            {github.repos.length === 0 ? (
              <p className="text-sm text-gray-600 dark:text-gray-300">
                No repositories are accessible to this installation. Grant the
                App access to your eve repo and try again.
              </p>
            ) : (
              <ul className="divide-y divide-gray-200 rounded-xl border border-gray-200 dark:divide-gray-800 dark:border-gray-800">
                {github.repos.map((r) => (
                  <li
                    key={r.fullName}
                    className="flex items-center justify-between px-4 py-3"
                  >
                    <div>
                      <span className="font-medium">{r.fullName}</span>
                      {r.private && (
                        <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                          private
                        </span>
                      )}
                    </div>
                    <Form method="post">
                      <input type="hidden" name="installationId" value={github.installationId} />
                      <input type="hidden" name="owner" value={r.owner} />
                      <input type="hidden" name="repo" value={r.repo} />
                      <input type="hidden" name="defaultBranch" value={r.defaultBranch} />
                      <button
                        type="submit"
                        disabled={submitting}
                        className="rounded-md bg-gray-200 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-300 disabled:opacity-50 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
                      >
                        {submitting ? "Connecting…" : "Connect"}
                      </button>
                    </Form>
                  </li>
                ))}
              </ul>
            )}

            {/* Create a new eve repo (eve init) */}
            <div className="mt-8 rounded-xl border border-dashed border-gray-300 p-5 dark:border-gray-700">
              <h2 className="text-sm font-semibold">Or create a new eve agent</h2>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Creates a repo in your organization and scaffolds an eve{" "}
                <span className="font-mono">agent/</span> skeleton.
              </p>
              <Form method="post" className="mt-3 flex flex-wrap items-center gap-2">
                <input type="hidden" name="intent" value="create" />
                <input
                  type="hidden"
                  name="installationId"
                  value={github.installationId}
                />
                <input
                  name="owner"
                  defaultValue={github.repos[0]?.owner ?? ""}
                  placeholder="org"
                  className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900"
                />
                <span className="text-gray-400">/</span>
                <input
                  name="name"
                  placeholder="my-agent"
                  className="rounded-md border border-gray-300 bg-white px-3 py-1.5 font-mono text-sm dark:border-gray-700 dark:bg-gray-900"
                />
                <button
                  type="submit"
                  disabled={submitting}
                  className="rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
                >
                  {submitting ? "Creating…" : "Create & scaffold"}
                </button>
              </Form>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
