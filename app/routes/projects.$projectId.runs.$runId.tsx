/**
 * Run transcript (Observe pillar, M3 — PRD §7.6). Progressive-disclosure timeline: the run
 * summary, then each step (model/tool call) with its I/O, tokens, timing, and errors. The
 * exact system prompt is reconstructable from the Release commit shown here (link, not snapshot).
 */
import { authkitLoader } from "@workos-inc/authkit-react-router";
import { Link, data, type LoaderFunctionArgs } from "react-router";

import { getRunWithSteps } from "~/observability/store.server";
import { requireProject } from "~/project/guard.server";
import type { Route } from "./+types/projects.$projectId.runs.$runId";

export const loader = (args: LoaderFunctionArgs) =>
  authkitLoader(
    args,
    async ({ auth }) => {
      const project = await requireProject(
        { user: auth.user, organizationId: auth.organizationId, role: auth.role },
        args.params.projectId,
      );
      const result = await getRunWithSteps(project.id, args.params.runId!);
      if (!result) throw data("Run not found", { status: 404 });
      return { project, ...result };
    },
    { ensureSignedIn: true },
  );

export function meta() {
  return [{ title: "Run · Eden" }];
}

export default function RunTranscript({ loaderData }: Route.ComponentProps) {
  const { project, run, steps, release } = loaderData;

  return (
    <main className="min-h-screen px-6 py-12 text-gray-900 dark:text-gray-100">
      <div className="mx-auto max-w-3xl">
        <Link
          to={`/projects/${project.id}/runs`}
          className="text-sm font-medium uppercase tracking-widest text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"
        >
          ← Runs
        </Link>
        <h1 className="mt-2 font-mono text-xl font-semibold tracking-tight">
          {run.externalRunId ?? run.id}
        </h1>

        {/* Summary */}
        <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <Metric label="Status" value={run.status} />
          <Metric
            label="Tokens"
            value={String((run.tokensInput ?? 0) + (run.tokensOutput ?? 0) || "—")}
          />
          <Metric
            label="Wall clock"
            value={run.wallClockMs == null ? "—" : `${(run.wallClockMs / 1000).toFixed(1)}s`}
          />
          <Metric label="Version" value={release?.version ?? "—"} />
        </dl>
        {release && (
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            Ran against commit{" "}
            <span className="font-mono">{release.gitSha.slice(0, 12)}</span> — the exact
            system prompt (instructions, tools, skills) is reconstructable from the repo at
            this commit.
          </p>
        )}
        {run.error && (
          <p className="mt-3 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-800/60 dark:bg-red-950/40 dark:text-red-200">
            {run.error}
          </p>
        )}

        {/* Timeline */}
        <h2 className="mt-8 text-lg font-semibold">Timeline</h2>
        {steps.length === 0 ? (
          <p className="mt-2 text-sm text-gray-400">
            No steps recorded for this run.
          </p>
        ) : (
          <ol className="mt-3 space-y-3">
            {steps.map((s) => (
              <li
                key={s.id}
                className="rounded-xl border border-gray-200 p-4 dark:border-gray-800"
              >
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium">
                    {s.type === "tool_call" && s.toolName
                      ? `tool: ${s.toolName}`
                      : s.type === "model_call" && s.model
                        ? `model: ${s.model}`
                        : s.type}
                    {s.isError && (
                      <span className="ml-2 text-red-600 dark:text-red-400">error</span>
                    )}
                    {s.approvalGated && (
                      <span className="ml-2 text-amber-600 dark:text-amber-400">
                        approval
                      </span>
                    )}
                  </span>
                  <span className="text-xs text-gray-400">
                    {s.durationMs != null ? `${s.durationMs}ms` : ""}
                    {(s.tokensInput ?? s.tokensOutput) != null
                      ? ` · ${(s.tokensInput ?? 0) + (s.tokensOutput ?? 0)} tok`
                      : ""}
                  </span>
                </div>
                {s.data && Object.keys(s.data).length > 0 && (
                  <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-gray-50 p-3 text-xs dark:bg-gray-900/40">
                    {JSON.stringify(s.data, null, 2)}
                  </pre>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-gray-200 px-3 py-2 dark:border-gray-800">
      <dt className="text-xs uppercase text-gray-400">{label}</dt>
      <dd className="mt-0.5 font-medium">{value}</dd>
    </div>
  );
}
