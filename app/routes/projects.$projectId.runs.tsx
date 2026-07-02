/**
 * Run list (Observe pillar, M3 — PRD §7.6). Scannable per-run summary metrics, filterable by
 * Release (compare-by-version — the emergent "A/B", D10). Also mints per-project ingest tokens
 * so BYO instances can ship telemetry back.
 */
import { authkitLoader, withAuth } from "@workos-inc/authkit-react-router";
import {
  Form,
  Link,
  redirect,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { listReleases } from "~/db/queries.server";
import {
  createIngestToken,
  listIngestTokens,
  listRuns,
} from "~/observability/store.server";
import { requireProject } from "~/project/guard.server";
import type { Route } from "./+types/projects.$projectId.runs";

export const loader = (args: LoaderFunctionArgs) =>
  authkitLoader(
    args,
    async ({ auth }) => {
      const project = await requireProject(
        { user: auth.user, organizationId: auth.organizationId, role: auth.role },
        args.params.projectId,
      );
      const releaseId =
        new URL(args.request.url).searchParams.get("release") || undefined;
      const [runsList, releasesList, tokens] = await Promise.all([
        listRuns(project.id, releaseId),
        listReleases(project.id),
        listIngestTokens(project.id),
      ]);
      return { project, runs: runsList, releases: releasesList, tokens, releaseId };
    },
    { ensureSignedIn: true },
  );

export async function action(args: ActionFunctionArgs) {
  const auth = await withAuth(args);
  if (!auth.user) throw redirect("/login");
  const project = await requireProject(
    {
      user: auth.user,
      organizationId: auth.organizationId ?? null,
      role: auth.role ?? null,
    },
    args.params.projectId,
  );
  const form = await args.request.formData();
  if (String(form.get("intent")) === "create-token") {
    const token = await createIngestToken(
      project.id,
      String(form.get("name") || "ingest"),
    );
    return { token };
  }
  return { token: null };
}

export function meta() {
  return [{ title: "Runs · Eden" }];
}

function ms(n: number | null) {
  return n == null ? "—" : n < 1000 ? `${n}ms` : `${(n / 1000).toFixed(1)}s`;
}

export default function Runs({ loaderData, actionData }: Route.ComponentProps) {
  const { project, runs, releases, tokens, releaseId } = loaderData;

  return (
    <main className="min-h-screen px-6 py-12 text-gray-900 dark:text-gray-100">
      <div className="mx-auto max-w-5xl">
        <Link
          to={`/projects/${project.id}`}
          className="text-sm font-medium uppercase tracking-widest text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"
        >
          ← {project.name}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Runs</h1>

        {/* Compare-by-version filter */}
        <Form method="get" className="mt-4 flex items-center gap-2">
          <label className="text-sm text-gray-600 dark:text-gray-300">Version</label>
          <select
            name="release"
            defaultValue={releaseId ?? ""}
            className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900"
          >
            <option value="">All</option>
            {releases.map((r) => (
              <option key={r.id} value={r.id}>
                {r.version}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="rounded-md bg-gray-200 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-200"
          >
            Filter
          </button>
        </Form>

        {runs.length === 0 ? (
          <p className="mt-6 text-sm text-gray-400">
            No runs recorded yet. Point an instance at{" "}
            <span className="font-mono">/api/ingest/runs</span> with an ingest token.
          </p>
        ) : (
          <table className="mt-6 w-full text-sm">
            <thead className="text-left text-xs uppercase text-gray-400">
              <tr>
                <th className="py-1">Run</th>
                <th>Version</th>
                <th>Status</th>
                <th>Tokens</th>
                <th>Duration</th>
                <th>Started</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="border-t border-gray-100 dark:border-gray-800">
                  <td className="py-1.5">
                    <Link
                      to={`/projects/${project.id}/runs/${r.id}`}
                      className="font-mono underline"
                    >
                      {r.externalRunId?.slice(0, 12) ?? r.id.slice(0, 8)}
                    </Link>
                    {r.channel && (
                      <span className="ml-2 text-gray-400">{r.channel}</span>
                    )}
                  </td>
                  <td>{r.version ?? "—"}</td>
                  <td>
                    <span
                      className={
                        r.status === "failed"
                          ? "text-red-600 dark:text-red-400"
                          : r.status === "completed"
                            ? "text-green-600 dark:text-green-400"
                            : "text-gray-500"
                      }
                    >
                      {r.status}
                    </span>
                  </td>
                  <td className="text-gray-500">
                    {(r.tokensInput ?? 0) + (r.tokensOutput ?? 0) || "—"}
                  </td>
                  <td className="text-gray-500">{ms(r.wallClockMs)}</td>
                  <td className="text-gray-500">
                    {new Date(r.startedAt).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* Ingest tokens */}
        <section className="mt-12 border-t border-gray-200 pt-6 dark:border-gray-800">
          <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400">
            Ingest tokens
          </h2>
          {actionData?.token && (
            <p className="mt-2 rounded-lg border border-green-300 bg-green-50 px-4 py-3 text-sm dark:border-green-800/60 dark:bg-green-950/40">
              New token (copy now — shown once):{" "}
              <code className="font-mono">{actionData.token}</code>
            </p>
          )}
          <ul className="mt-2 text-sm text-gray-500">
            {tokens.map((t) => (
              <li key={t.id}>
                {t.name} · created {new Date(t.createdAt).toLocaleDateString()}
                {t.lastUsedAt
                  ? ` · last used ${new Date(t.lastUsedAt).toLocaleDateString()}`
                  : " · never used"}
              </li>
            ))}
          </ul>
          <Form method="post" className="mt-3 flex items-center gap-2">
            <input type="hidden" name="intent" value="create-token" />
            <input
              name="name"
              placeholder="production instance"
              className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900"
            />
            <button
              type="submit"
              className="rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
            >
              Create ingest token
            </button>
          </Form>
        </section>
      </div>
    </main>
  );
}
