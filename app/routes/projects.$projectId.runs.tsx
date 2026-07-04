/**
 * Run list (Observe pillar, M3 — PRD §7.6). Scannable per-run summary metrics, filterable by
 * Release (compare-by-version — the emergent "A/B", D10). Member-scoped (M5.8): team members'
 * runs live at /repos/:id/agents/:name/runs; single-agent repos at /repos/:id/runs. Ingest
 * tokens are minted on the repository's Settings tab.
 */
import { authkitLoader } from "@workos-inc/authkit-react-router";
import { Form, Link, redirect, type LoaderFunctionArgs } from "react-router";

import { AgentNav, AppShell, PageHeader, repoCrumbs } from "~/components/shell";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Label } from "~/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { listReleases } from "~/db/queries.server";
import { listRuns } from "~/observability/store.server";
import { contextPath } from "~/lib/paths";
import {
  agentFromParams,
  agentParamRedirect,
  resolveAgentContext,
} from "~/project/agent-context.server";
import { requireProject } from "~/project/guard.server";
import type { Route } from "./+types/projects.$projectId.runs";

export const loader = (args: LoaderFunctionArgs) =>
  authkitLoader(
    args,
    async ({ auth }) => {
      const project = await requireProject(
        {
          user: auth.user,
          organizationId: auth.organizationId,
          role: auth.role,
        },
        args.params.projectId,
      );
      const agentName = agentFromParams(args.params);
      if (!agentName) {
        const legacy = agentParamRedirect(args.request, project.id);
        if (legacy) throw legacy;
      }
      const { roster, active, isTeam } = await resolveAgentContext(
        project.id,
        agentName,
      );
      // Teams have no repo-level Runs — the tab exists only at the member level.
      if (isTeam && !agentName) throw redirect(`/repos/${project.id}`);
      const raw = new URL(args.request.url).searchParams.get("release");
      // "all" is the picker's explicit no-filter sentinel (Radix items can't be empty).
      const releaseId = raw && raw !== "all" ? raw : undefined;
      const [runsList, releasesList] = await Promise.all([
        // Always the active member's runs (single-agent repos: the only member).
        listRuns(project.id, { releaseId, agentId: active.id }),
        listReleases(project.id),
      ]);
      return {
        project,
        roster: roster.map((a) => ({ name: a.name })),
        activeAgent: active.name,
        isTeam,
        runs: runsList,
        releases: releasesList.filter(
          (r) => !isTeam || r.agentId === active.id,
        ),
        releaseId,
      };
    },
    { ensureSignedIn: true },
  );

export function meta() {
  return [{ title: "Runs · Eden" }];
}

function ms(n: number | null) {
  return n == null ? "—" : n < 1000 ? `${n}ms` : `${(n / 1000).toFixed(1)}s`;
}

/** Map a run status to a shadcn Badge variant: failed→destructive, completed→secondary, else outline. */
function statusVariant(
  status: string,
): "secondary" | "outline" | "destructive" {
  if (status === "failed") return "destructive";
  if (status === "completed" || status === "success") return "secondary";
  return "outline";
}

export default function Runs({ loaderData }: Route.ComponentProps) {
  const { project, roster, activeAgent, isTeam, runs, releases, releaseId } =
    loaderData;
  const ctx = contextPath(project.id, isTeam ? activeAgent : null);

  return (
    <AppShell
      breadcrumbs={repoCrumbs({
        projectId: project.id,
        repoName: project.name,
        isTeam: isTeam,
        agentName: activeAgent,
        tail: [{ label: "Runs" }],
      })}
    >
      <AgentNav
        base={ctx}
        level={isTeam ? "member" : "single"}
        roster={roster}
        activeAgent={isTeam ? activeAgent : undefined}
      />
      <PageHeader
        title={isTeam ? `Runs — ${activeAgent}` : "Runs"}
        description="Per-run summary metrics, filterable by release to compare versions."
      />

      {/* Compare-by-version filter (the path carries the member context) */}
      <Form method="get" className="mb-6 flex items-end gap-2">
        <div className="grid gap-1.5">
          <Label htmlFor="release">Version</Label>
          <Select name="release" defaultValue={releaseId ?? "all"}>
            <SelectTrigger id="release" className="min-w-32">
              <SelectValue placeholder="All" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              {releases.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.version}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button type="submit" variant="secondary">
          Filter
        </Button>
      </Form>

      {runs.length === 0 ? (
        <Card className="border-dashed">
          <CardHeader className="items-center py-12 text-center">
            <CardTitle className="text-lg">No runs yet</CardTitle>
            <CardDescription>
              Point an instance at{" "}
              <span className="font-mono">/api/ingest/runs</span> with an ingest
              token to start recording runs — tokens are created on the
              repository&rsquo;s Settings tab.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Run</TableHead>
                  <TableHead>Version</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Tokens</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Started</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>
                      <Link
                        to={`${ctx}/runs/${r.id}`}
                        className="font-mono underline-offset-4 hover:underline"
                      >
                        {r.externalRunId?.slice(0, 12) ?? r.id.slice(0, 8)}
                      </Link>
                      {r.channel && (
                        <span className="ml-2 text-muted-foreground">
                          {r.channel}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>{r.version ?? "—"}</TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(r.status)}>
                        {r.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {(r.tokensInput ?? 0) + (r.tokensOutput ?? 0) || "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {ms(r.wallClockMs)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(r.startedAt).toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </AppShell>
  );
}
