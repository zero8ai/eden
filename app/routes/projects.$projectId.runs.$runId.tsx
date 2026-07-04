/**
 * Run transcript (Observe pillar, M3 — PRD §7.6). Progressive-disclosure timeline: the run
 * summary, then each step (model/tool call) with its I/O, tokens, timing, and errors. The
 * exact system prompt is reconstructable from the Release commit shown here (link, not snapshot).
 */
import { authkitLoader } from "@workos-inc/authkit-react-router";
import type { ReactNode } from "react";
import { Link, data, type LoaderFunctionArgs } from "react-router";

import { AgentNav, AppShell, PageHeader } from "~/components/shell";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { getRunWithSteps } from "~/observability/store.server";
import { agentParam, resolveAgentContext } from "~/project/agent-context.server";
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
      const [result, { roster, active }] = await Promise.all([
        getRunWithSteps(project.id, args.params.runId!),
        resolveAgentContext(project.id, agentParam(args.request)),
      ]);
      if (!result) throw data("Run not found", { status: 404 });
      return {
        project,
        ...result,
        roster: roster.map((a) => ({ name: a.name })),
        activeAgent: active.name,
      };
    },
    { ensureSignedIn: true },
  );

export function meta() {
  return [{ title: "Run · Eden" }];
}

/** Map a run status to a shadcn Badge variant: failed→destructive, completed→secondary, else outline. */
function statusVariant(
  status: string,
): "secondary" | "outline" | "destructive" {
  if (status === "failed") return "destructive";
  if (status === "completed" || status === "success") return "secondary";
  return "outline";
}

export default function RunTranscript({ loaderData }: Route.ComponentProps) {
  const { project, run, steps, release, roster, activeAgent } = loaderData;
  const base = `/projects/${project.id}`;

  return (
    <AppShell>
      <PageHeader
        title={run.externalRunId ?? run.id}
        description="Progressive-disclosure timeline of each model and tool step."
        actions={
          <Button variant="outline" asChild>
            <Link to={`${base}/runs`}>← Runs</Link>
          </Button>
        }
      />
      <AgentNav base={base} roster={roster} activeAgent={activeAgent} />

      {/* Summary */}
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <Metric label="Status">
          <Badge variant={statusVariant(run.status)}>{run.status}</Badge>
        </Metric>
        <Metric label="Tokens">
          {String((run.tokensInput ?? 0) + (run.tokensOutput ?? 0) || "—")}
        </Metric>
        <Metric label="Wall clock">
          {run.wallClockMs == null
            ? "—"
            : `${(run.wallClockMs / 1000).toFixed(1)}s`}
        </Metric>
        <Metric label="Version">{release?.version ?? "—"}</Metric>
      </dl>
      {release && (
        <p className="mt-2 text-xs text-muted-foreground">
          Ran against commit{" "}
          <span className="font-mono">{release.gitSha.slice(0, 12)}</span> — the
          exact system prompt (instructions, tools, skills) is reconstructable
          from the repo at this commit.
        </p>
      )}
      {run.error && (
        <Alert variant="destructive" className="mt-3">
          <AlertTitle>Run failed</AlertTitle>
          <AlertDescription>{run.error}</AlertDescription>
        </Alert>
      )}

      {/* Timeline */}
      <h2 className="mt-8 text-lg font-semibold">Timeline</h2>
      {steps.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          No steps recorded for this run.
        </p>
      ) : (
        <ol className="mt-3 space-y-3">
          {steps.map((s) => (
            <li
              key={s.id}
              className="rounded-xl border bg-card p-4 text-card-foreground"
            >
              <div className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2 font-medium">
                  {s.type === "tool_call" && s.toolName
                    ? `tool: ${s.toolName}`
                    : s.type === "model_call" && s.model
                      ? `model: ${s.model}`
                      : s.type}
                  {s.isError && <Badge variant="destructive">error</Badge>}
                  {s.approvalGated && <Badge variant="outline">approval</Badge>}
                </span>
                <span className="text-xs text-muted-foreground">
                  {s.durationMs != null ? `${s.durationMs}ms` : ""}
                  {(s.tokensInput ?? s.tokensOutput) != null
                    ? ` · ${(s.tokensInput ?? 0) + (s.tokensOutput ?? 0)} tok`
                    : ""}
                </span>
              </div>
              {s.data && Object.keys(s.data).length > 0 && (
                <pre className="mt-2 max-h-64 overflow-auto rounded-lg border bg-muted/40 p-3 text-xs">
                  {JSON.stringify(s.data, null, 2)}
                </pre>
              )}
            </li>
          ))}
        </ol>
      )}
    </AppShell>
  );
}

function Metric({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-lg border px-3 py-2">
      <dt className="text-xs uppercase text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-medium">{children}</dd>
    </div>
  );
}
