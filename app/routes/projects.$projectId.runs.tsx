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

import { AgentNav, AppShell, PageHeader } from "~/components/shell";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Input } from "~/components/ui/input";
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
      const raw = new URL(args.request.url).searchParams.get("release");
      // "all" is the picker's explicit no-filter sentinel (Radix items can't be empty).
      const releaseId = raw && raw !== "all" ? raw : undefined;
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

/** Map a run status to a shadcn Badge variant: failed→destructive, completed→secondary, else outline. */
function statusVariant(
  status: string,
): "secondary" | "outline" | "destructive" {
  if (status === "failed") return "destructive";
  if (status === "completed" || status === "success") return "secondary";
  return "outline";
}

export default function Runs({ loaderData, actionData }: Route.ComponentProps) {
  const { project, runs, releases, tokens, releaseId } = loaderData;
  const base = `/projects/${project.id}`;

  return (
    <AppShell>
      <PageHeader
        title="Runs"
        description="Per-run summary metrics, filterable by release to compare versions."
      />
      <AgentNav base={base} />

      {/* Compare-by-version filter */}
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
              token to start recording runs.
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
                        to={`/projects/${project.id}/runs/${r.id}`}
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
                      <Badge variant={statusVariant(r.status)}>{r.status}</Badge>
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

      {/* Ingest tokens */}
      <Card className="mt-8">
        <CardHeader>
          <CardTitle className="text-base">Ingest tokens</CardTitle>
          <CardDescription>
            BYO instances use these tokens to ship telemetry back to Eden.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {actionData?.token && (
            <Alert>
              <AlertTitle>New token — copy now, shown once</AlertTitle>
              <AlertDescription>
                <code className="font-mono">{actionData.token}</code>
              </AlertDescription>
            </Alert>
          )}
          {tokens.length > 0 && (
            <ul className="space-y-1 text-sm text-muted-foreground">
              {tokens.map((t) => (
                <li key={t.id}>
                  {t.name} · created{" "}
                  {new Date(t.createdAt).toLocaleDateString()}
                  {t.lastUsedAt
                    ? ` · last used ${new Date(t.lastUsedAt).toLocaleDateString()}`
                    : " · never used"}
                </li>
              ))}
            </ul>
          )}
          <Form method="post" className="flex items-center gap-2">
            <input type="hidden" name="intent" value="create-token" />
            <Input
              name="name"
              placeholder="production instance"
              className="max-w-xs"
            />
            <Button type="submit">Create ingest token</Button>
          </Form>
        </CardContent>
      </Card>
    </AppShell>
  );
}
