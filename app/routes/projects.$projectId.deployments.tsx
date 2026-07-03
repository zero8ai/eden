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
  redirect,
  useSearchParams,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { AgentNav, AppShell, PageHeader } from "~/components/shell";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import {
  createRelease,
  listDeployments,
  setTrafficSplit,
} from "~/deploy/controller.server";
import { listEnvironments, listReleases } from "~/db/queries.server";
import { getBranchHead } from "~/github/repo.server";
import { enqueue } from "~/jobs/queue.server";
import { ensureWorkerStarted } from "~/jobs/worker.server";
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
    } else if (intent === "deploy" || intent === "rollback") {
      // Builds take minutes — enqueue and let the worker run it; the list shows progress.
      ensureWorkerStarted();
      await enqueue(intent === "deploy" ? "deploy_release" : "rollback_release", {
        environmentId: String(form.get("environmentId")),
        releaseId: String(form.get("releaseId")),
        createdBy: auth.user.id,
      });
    } else if (intent === "split") {
      const environmentId = String(form.get("environmentId"));
      const weights = [...form.entries()].flatMap(([k, v]) =>
        k.startsWith("weight:")
          ? [{ deploymentId: k.slice("weight:".length), weight: Number(v) || 0 }]
          : [],
      );
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
  const base = `/projects/${project.id}`;
  const [params] = useSearchParams();
  // Set when the human just merged a change on the Changes tab — the new version is now here,
  // ready to deploy. Preselect it in the environment deploy selectors below.
  const justReleased = params.get("released");
  const justReleasedId = justReleased
    ? releases.find((r) => r.version === justReleased)?.id
    : undefined;

  return (
    <AppShell>
      <PageHeader
        title="Deployments"
        description="Immutable releases from the default branch, deployed across environments behind a session-sticky traffic split."
        actions={
          <Form method="post">
            <input type="hidden" name="intent" value="cut-release" />
            <Button type="submit">
              Cut release from {project.defaultBranch}
            </Button>
          </Form>
        }
      />
      <AgentNav base={base} />

      {justReleased && (
        <Alert className="mb-6">
          <AlertTitle>{justReleased} is ready to deploy</AlertTitle>
          <AlertDescription>
            Your change was merged and cut as release{" "}
            <span className="font-semibold">{justReleased}</span>. Deploy it to an
            environment below — pick a weight to run it alongside the current version, or
            deploy at 100% to replace it.
          </AlertDescription>
        </Alert>
      )}

      {actionData?.error && (
        <Alert variant="destructive" className="mb-6">
          <AlertTitle>Action failed</AlertTitle>
          <AlertDescription>{actionData.error}</AlertDescription>
        </Alert>
      )}

      {/* Releases */}
      <Card className="mb-6">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Releases</CardTitle>
        </CardHeader>
        <CardContent>
          {releases.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No releases yet. Cut one from the default branch to deploy.
            </p>
          ) : (
            <ul className="divide-y rounded-lg border text-sm">
              {releases.map((r) => (
                <li key={r.id} className="flex items-center gap-2 px-4 py-2">
                  <span className="font-semibold">{r.version}</span>
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                    {r.gitSha.slice(0, 7)}
                  </code>
                  {r.changelog && (
                    <span className="truncate text-muted-foreground">
                      {r.changelog}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Environments */}
      <div className="space-y-6">
      {envs.map(({ env, deployments }) => (
          <Card key={env.id}>
            <CardHeader className="pb-3">
              <CardTitle className="text-base capitalize">{env.name}</CardTitle>
            </CardHeader>
            <CardContent>
            {deployments.length === 0 ? (
              <p className="text-sm text-muted-foreground">No deployments.</p>
            ) : (
              <Form method="post">
                <input type="hidden" name="intent" value="split" />
                <input type="hidden" name="environmentId" value={env.id} />
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Release</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Weight</TableHead>
                      <TableHead>URL</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {deployments.map((d) => (
                      <TableRow key={d.id}>
                        <TableCell className="font-semibold">
                          {d.version}{" "}
                          <code className="font-mono text-xs font-normal text-muted-foreground">
                            {d.gitSha.slice(0, 7)}
                          </code>
                        </TableCell>
                        <TableCell>
                          <span className="flex items-center gap-1">
                            <StatusBadge status={d.status} />
                            {d.status === "failed" && d.errorDetail && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="cursor-help text-xs text-destructive underline underline-offset-2">
                                    why?
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent className="max-w-sm">
                                  {d.errorDetail}
                                </TooltipContent>
                              </Tooltip>
                            )}
                          </span>
                        </TableCell>
                        <TableCell>
                          <Input
                            name={`weight:${d.id}`}
                            type="number"
                            min={0}
                            defaultValue={d.trafficWeight}
                            className="h-8 w-20"
                          />
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {d.url ? (
                            <a href={d.url} className="underline underline-offset-4">
                              open
                            </a>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <Button type="submit" size="sm" variant="secondary" className="mt-3">
                  Save split
                </Button>
              </Form>
            )}

            {releases.length > 0 && (
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Form method="post" className="flex items-center gap-2">
                  <input type="hidden" name="intent" value="deploy" />
                  <input type="hidden" name="environmentId" value={env.id} />
                  <ReleaseSelect
                    releases={releases}
                    defaultValue={justReleasedId ?? releases[0]?.id}
                    label="Release to deploy"
                  />
                  <Button type="submit" size="sm">
                    Deploy
                  </Button>
                </Form>
                <Form method="post" className="flex items-center gap-2">
                  <input type="hidden" name="intent" value="rollback" />
                  <input type="hidden" name="environmentId" value={env.id} />
                  <ReleaseSelect
                    releases={releases}
                    defaultValue={releases[0]?.id}
                    label="Release to roll back to"
                  />
                  <Button type="submit" size="sm" variant="secondary">
                    Rollback to
                  </Button>
                </Form>
              </div>
            )}
            </CardContent>
          </Card>
        ))}
      </div>
    </AppShell>
  );
}

/** Release picker for deploy/rollback forms; posts `releaseId` via Radix's hidden select. */
function ReleaseSelect({
  releases,
  defaultValue,
  label,
}: {
  releases: { id: string; version: string; gitSha: string }[];
  defaultValue?: string;
  label: string;
}) {
  return (
    <Select name="releaseId" defaultValue={defaultValue}>
      <SelectTrigger className="min-w-32" aria-label={label}>
        <SelectValue placeholder="Release" />
      </SelectTrigger>
      <SelectContent>
        {releases.map((r) => (
          <SelectItem key={r.id} value={r.id}>
            {r.version}{" "}
            <span className="font-mono text-xs text-muted-foreground">
              {r.gitSha.slice(0, 7)}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function StatusBadge({ status }: { status: string }) {
  const variant =
    status === "live"
      ? "default"
      : status === "failed"
        ? "destructive"
        : "secondary";
  return (
    <Badge variant={variant} className="capitalize">
      {status}
    </Badge>
  );
}
