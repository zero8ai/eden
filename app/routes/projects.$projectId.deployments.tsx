/**
 * Deploy & versioning UI (Deploy pillar, M2 — PRD §7.4/§7.7).
 *
 * Cut immutable Releases from the repo, deploy them into environments, run multiple Releases
 * live behind a weighted split, and fast-rollback to a prior Release. Everything ships through
 * the deploy controller over the DeployTarget seam.
 */
import { authkitLoader, withAuth } from "@workos-inc/authkit-react-router";
import {
  Form,
  Link,
  redirect,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import {
  createRelease,
  deployRelease,
  listDeployments,
  rollbackTo,
  setTrafficSplit,
} from "~/deploy/controller.server";
import { listEnvironments, listReleases } from "~/db/queries.server";
import { getBranchHead } from "~/github/repo.server";
import { requireProject, requireRepo } from "~/project/guard.server";
import type { Route } from "./+types/projects.$projectId.deployments";

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
      const [releaseRows, envRows] = await Promise.all([
        listReleases(project.id),
        listEnvironments(project.id),
      ]);
      const envs = await Promise.all(
        envRows.map(async (env) => ({
          env,
          deployments: await listDeployments(env.id),
        })),
      );
      return { project, releases: releaseRows, envs };
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
  const back = `/projects/${project.id}/deployments`;

  try {
    if (intent === "cut-release") {
      const head = await getBranchHead(project.repoInstallationId, {
        owner: project.repoOwner,
        repo: project.repoName,
      });
      await createRelease({
        projectId: project.id,
        gitSha: head.sha,
        changelog: `Cut from ${head.branch} @ ${head.sha.slice(0, 7)}`,
        createdBy: auth.user.id,
      });
    } else if (intent === "deploy") {
      await deployRelease({
        environmentId: String(form.get("environmentId")),
        releaseId: String(form.get("releaseId")),
        createdBy: auth.user.id,
      });
    } else if (intent === "rollback") {
      await rollbackTo({
        environmentId: String(form.get("environmentId")),
        releaseId: String(form.get("releaseId")),
        createdBy: auth.user.id,
      });
    } else if (intent === "split") {
      const environmentId = String(form.get("environmentId"));
      const weights = [...form.entries()]
        .filter(([k]) => k.startsWith("weight:"))
        .map(([k, v]) => ({ deploymentId: k.slice("weight:".length), weight: Number(v) || 0 }));
      await setTrafficSplit(environmentId, weights);
    }
  } catch (error) {
    return { error: (error as Error).message };
  }
  throw redirect(back);
}

export function meta() {
  return [{ title: "Deployments · Eden" }];
}

export default function Deployments({ loaderData, actionData }: Route.ComponentProps) {
  const { project, releases, envs } = loaderData;

  return (
    <main className="min-h-screen px-6 py-12 text-gray-900 dark:text-gray-100">
      <div className="mx-auto max-w-4xl">
        <Link
          to={`/projects/${project.id}`}
          className="text-sm font-medium uppercase tracking-widest text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"
        >
          ← {project.name}
        </Link>
        <div className="mt-2 flex items-center justify-between">
          <h1 className="text-2xl font-semibold tracking-tight">Deployments</h1>
          <Form method="post">
            <input type="hidden" name="intent" value="cut-release" />
            <button
              type="submit"
              className="rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
            >
              Cut release from {project.defaultBranch}
            </button>
          </Form>
        </div>

        {actionData?.error && (
          <p className="mt-6 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-800/60 dark:bg-red-950/40 dark:text-red-200">
            {actionData.error}
          </p>
        )}

        {/* Releases */}
        <section className="mt-8">
          <h2 className="text-lg font-semibold">Releases</h2>
          {releases.length === 0 ? (
            <p className="mt-2 text-sm text-gray-400">
              No releases yet. Cut one from the default branch to deploy.
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-gray-200 rounded-xl border border-gray-200 text-sm dark:divide-gray-800 dark:border-gray-800">
              {releases.map((r) => (
                <li key={r.id} className="flex items-center justify-between px-4 py-2">
                  <span>
                    <span className="font-semibold">{r.version}</span>{" "}
                    <span className="font-mono text-gray-500">{r.gitSha.slice(0, 7)}</span>
                    {r.changelog && (
                      <span className="ml-2 text-gray-500 dark:text-gray-400">
                        {r.changelog}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Environments */}
        {envs.map(({ env, deployments }) => (
          <section
            key={env.id}
            className="mt-8 rounded-xl border border-gray-200 p-5 dark:border-gray-800"
          >
            <h2 className="text-lg font-semibold capitalize">{env.name}</h2>

            {deployments.length === 0 ? (
              <p className="mt-2 text-sm text-gray-400">No deployments.</p>
            ) : (
              <Form method="post" className="mt-3">
                <input type="hidden" name="intent" value="split" />
                <input type="hidden" name="environmentId" value={env.id} />
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase text-gray-400">
                    <tr>
                      <th className="py-1">Release</th>
                      <th>Status</th>
                      <th>Weight</th>
                      <th>URL</th>
                    </tr>
                  </thead>
                  <tbody>
                    {deployments.map((d) => (
                      <tr key={d.id} className="border-t border-gray-100 dark:border-gray-800">
                        <td className="py-1.5 font-semibold">
                          {d.version}{" "}
                          <span className="font-mono font-normal text-gray-400">
                            {d.gitSha.slice(0, 7)}
                          </span>
                        </td>
                        <td>
                          <StatusBadge status={d.status} />
                        </td>
                        <td>
                          <input
                            name={`weight:${d.id}`}
                            type="number"
                            min={0}
                            defaultValue={d.trafficWeight}
                            className="w-16 rounded border border-gray-300 bg-white px-2 py-0.5 dark:border-gray-700 dark:bg-gray-900"
                          />
                        </td>
                        <td className="text-gray-500">
                          {d.url ? (
                            <a href={d.url} className="underline">
                              open
                            </a>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <button
                  type="submit"
                  className="mt-2 rounded-md bg-gray-200 px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-200"
                >
                  Save split
                </button>
              </Form>
            )}

            {releases.length > 0 && (
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Form method="post" className="flex items-center gap-2">
                  <input type="hidden" name="intent" value="deploy" />
                  <input type="hidden" name="environmentId" value={env.id} />
                  <select
                    name="releaseId"
                    className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900"
                  >
                    {releases.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.version}
                      </option>
                    ))}
                  </select>
                  <button
                    type="submit"
                    className="rounded-md bg-gray-900 px-3 py-1 text-sm font-medium text-white hover:bg-gray-700 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
                  >
                    Deploy
                  </button>
                </Form>
                <Form method="post" className="flex items-center gap-2">
                  <input type="hidden" name="intent" value="rollback" />
                  <input type="hidden" name="environmentId" value={env.id} />
                  <select
                    name="releaseId"
                    className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900"
                  >
                    {releases.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.version}
                      </option>
                    ))}
                  </select>
                  <button
                    type="submit"
                    className="rounded-md bg-gray-200 px-3 py-1 text-sm font-medium text-gray-700 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-200"
                  >
                    Rollback to
                  </button>
                </Form>
              </div>
            )}
          </section>
        ))}
      </div>
    </main>
  );
}

function StatusBadge({ status }: { status: string }) {
  const color =
    status === "live"
      ? "bg-green-100 text-green-700 dark:bg-green-950/50 dark:text-green-300"
      : status === "failed"
        ? "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300"
        : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300";
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${color}`}>
      {status}
    </span>
  );
}
