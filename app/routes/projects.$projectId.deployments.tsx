/**
 * Versions — the deploy surface (Deploy pillar, M2 + M6 — PRD §7.4/§7.7).
 *
 * The mental model is deliberately small: an agent has VERSIONS; exactly ONE version is live
 * per environment. Production is the page's hero; the version history below lets any past
 * version be made live again in one click (fast rollback — the image is reused, no rebuild).
 * Shipping a NEW version happens on the Overview (Ship) or via Changes → merge; this page is
 * where you see and move what's live.
 */
import { authkitLoader, withAuth } from "@workos-inc/authkit-react-router";
import { useEffect } from "react";
import {
  redirect,
  useFetcher,
  useRevalidator,
  useSearchParams,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { ConfirmDialog } from "~/components/confirm-dialog";
import { AgentNav, AppShell, PageHeader, repoCrumbs } from "~/components/shell";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { clearFailedDeployments, listDeployments, queueDeploy } from "~/deploy/controller.server";
import { listAgentEnvironments, listReleases } from "~/db/queries.server";
import { ensureWorkerStarted } from "~/jobs/worker.server";
import { timeAgo } from "~/lib/time";
import { agentParam, resolveAgentContext } from "~/project/agent-context.server";
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
      // Everything on this page is per roster member: its releases, its environments.
      const { roster, active, isTeam } = await resolveAgentContext(
        project.id,
        agentParam(args.request),
      );
      const [releaseRows, envRows] = await Promise.all([
        listReleases(project.id),
        listAgentEnvironments(active.id),
      ]);
      const envs = await Promise.all(
        envRows.map(async (env) => ({
          env,
          deployments: await listDeployments(env.id),
        })),
      );
      return {
        project,
        roster: roster.map((a) => ({ name: a.name })),
        activeAgent: active.name,
        isTeam,
        releases: releaseRows.filter((r) => r.agentId === active.id),
        envs,
      };
    },
    { ensureSignedIn: true },
  );

export async function action(args: ActionFunctionArgs) {
  const auth = await withAuth(args);
  if (!auth.user) throw redirect("/login");
  requireRepo(
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

  try {
    if (intent === "make-live" || intent === "retry") {
      // Both are a cutover deploy of a chosen release; "make-live" of a past version rides
      // the rollback job (fast — image reuse), a retry re-runs the forward deploy.
      // queueDeploy creates the row in `queued` BEFORE enqueueing so the click has an
      // immediately visible result; the worker takes it to building → live.
      ensureWorkerStarted();
      await queueDeploy({
        environmentId: String(form.get("environmentId")),
        releaseId: String(form.get("releaseId")),
        rollback: intent === "make-live",
        createdBy: auth.user.id,
      });
      return { ok: true as const };
    }
    if (intent === "clear-failed") {
      await clearFailedDeployments(String(form.get("environmentId")));
      return { ok: true as const };
    }
    return { error: "Unknown action." };
  } catch (error) {
    if (error instanceof Response) throw error;
    return { error: (error as Error).message };
  }
}

export function meta() {
  return [{ title: "Versions · Eden" }];
}

type LoaderData = Route.ComponentProps["loaderData"];
type Env = LoaderData["envs"][number]["env"];
type DeploymentRow = LoaderData["envs"][number]["deployments"][number];
type ReleaseRow = LoaderData["releases"][number];

const IN_FLIGHT = new Set(["queued", "pending", "building"]);

/** Newest live deployment of an environment (post-migration there is at most one). */
function liveOf(deployments: DeploymentRow[]): DeploymentRow | undefined {
  return deployments.find((d) => d.status === "live");
}

export default function Versions({ loaderData, actionData }: Route.ComponentProps) {
  const { project, roster, activeAgent, isTeam, releases, envs } = loaderData;
  const base = `/repos/${project.id}`;
  const [params] = useSearchParams();
  // Set when the human just merged a change on the Changes tab — the new version is now
  // here, ready to be made live.
  const justReleased = params.get("released");

  // Live progress: while any deployment is queued/building, re-fetch every few seconds so
  // statuses walk queued → building → live/failed without a manual refresh.
  const revalidator = useRevalidator();
  const inFlight = envs.some(({ deployments }) =>
    deployments.some((d) => IN_FLIGHT.has(d.status)),
  );
  useEffect(() => {
    if (!inFlight) return;
    const timer = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 3000);
    return () => clearInterval(timer);
  }, [inFlight, revalidator]);

  const production = envs.find(({ env }) => env.name === "production") ?? envs[0];
  const others = envs.filter((e) => e !== production);
  // Which environments each release is live in, for the history rows' badges.
  const liveEnvNames = new Map<string, string[]>();
  for (const { env, deployments } of envs) {
    const live = liveOf(deployments);
    if (!live) continue;
    liveEnvNames.set(live.releaseId, [...(liveEnvNames.get(live.releaseId) ?? []), env.name]);
  }

  return (
    <AppShell breadcrumbs={repoCrumbs({ projectId: project.id, repoName: project.name, isTeam: isTeam, agentName: activeAgent, tail: [{ label: "Versions" }] })}>
      <PageHeader
        title={isTeam ? `Versions — ${activeAgent}` : "Versions"}
        description={
          isTeam
            ? "This member's versions. One version is live per environment; any past version can be made live again in one click."
            : "Every version of this agent, newest first. One version is live per environment; any past version can be made live again in one click."
        }
      />
      <AgentNav base={base} roster={roster} activeAgent={activeAgent} />

      {justReleased && (
        <Alert className="mb-6">
          <AlertTitle>{justReleased} is ready</AlertTitle>
          <AlertDescription>
            Your change was merged and cut as version{" "}
            <span className="font-semibold">{justReleased}</span>. Make it live from the
            version history below.
          </AlertDescription>
        </Alert>
      )}

      {actionData?.error && (
        <Alert variant="destructive" className="mb-6">
          <AlertTitle>Action failed</AlertTitle>
          <AlertDescription>{actionData.error}</AlertDescription>
        </Alert>
      )}

      {production && (
        <ProductionCard env={production.env} deployments={production.deployments} />
      )}

      <VersionHistory
        releases={releases}
        production={production?.env ?? null}
        others={others.map((o) => o.env)}
        liveEnvNames={liveEnvNames}
      />

      {others.length > 0 && (
        <Card className="mt-6">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Other environments</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y rounded-lg border text-sm">
              {others.map(({ env, deployments }) => {
                const live = liveOf(deployments);
                const pending = deployments.find((d) => IN_FLIGHT.has(d.status));
                return (
                  <li key={env.id} className="flex items-center gap-3 px-4 py-2">
                    <span className="w-32 shrink-0 font-medium capitalize">{env.name}</span>
                    {live ? (
                      <>
                        <span className="font-semibold">{live.version}</span>
                        <Badge>Live</Badge>
                        <span className="text-muted-foreground">
                          {timeAgo(live.createdAt)}
                        </span>
                        {live.url && (
                          <a href={live.url} className="underline underline-offset-4">
                            open
                          </a>
                        )}
                      </>
                    ) : (
                      <span className="text-muted-foreground">nothing deployed</span>
                    )}
                    {pending && (
                      <span className="text-muted-foreground">
                        · {pending.version} {pending.status}…
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}
    </AppShell>
  );
}

/**
 * The hero: what production is running right now, plus in-flight progress and the latest
 * failure (with retry). Superseded/stopped rows are deliberately absent — the version
 * history is the durable record, old deployment rows are infrastructure.
 */
function ProductionCard({ env, deployments }: { env: Env; deployments: DeploymentRow[] }) {
  const fetcher = useFetcher<typeof action>();
  const live = liveOf(deployments);
  const pending = deployments.find((d) => IN_FLIGHT.has(d.status));
  // Only a failure newer than the live deployment matters ("v8 failed, v7 still live");
  // older ones are stale post-mortems the Dismiss button clears anyway.
  const failed = deployments.find((d) => d.status === "failed");
  const failedCount = deployments.filter((d) => d.status === "failed").length;
  const busy = fetcher.state !== "idle";

  return (
    <Card className="mb-6">
      <CardHeader className="pb-3">
        <CardTitle className="text-base capitalize">{env.name}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {live ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-2xl font-semibold">{live.version}</span>
            <Badge>Live</Badge>
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
              {live.gitSha.slice(0, 7)}
            </code>
            <span className="text-sm text-muted-foreground">
              deployed {timeAgo(live.createdAt)}
            </span>
            {live.url && (
              <a href={live.url} className="text-sm underline underline-offset-4">
                open
              </a>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Nothing live yet. Make a version live below, or Ship from the Overview.
          </p>
        )}

        {pending && (
          <p className="text-sm text-muted-foreground">
            {pending.version} is {pending.status === "building" ? "building" : "queued"}… it
            goes live once healthy{live ? `, replacing ${live.version}` : ""}.
          </p>
        )}

        {failed && (
          <Alert variant="destructive">
            <AlertTitle>
              {failed.version} failed to go live
              {live ? ` — ${live.version} is still serving` : ""}
            </AlertTitle>
            <AlertDescription>
              <div className="flex flex-wrap items-center gap-2">
                {failed.errorDetail && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="cursor-help text-xs underline underline-offset-2">
                        why?
                      </span>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-sm">{failed.errorDetail}</TooltipContent>
                  </Tooltip>
                )}
                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="retry" />
                  <input type="hidden" name="environmentId" value={env.id} />
                  <input type="hidden" name="releaseId" value={failed.releaseId} />
                  <Button type="submit" size="sm" variant="outline" disabled={busy}>
                    Retry
                  </Button>
                </fetcher.Form>
                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="clear-failed" />
                  <input type="hidden" name="environmentId" value={env.id} />
                  <Button type="submit" size="sm" variant="ghost" disabled={busy}>
                    Dismiss{failedCount > 1 ? ` ${failedCount} failures` : ""}
                  </Button>
                </fetcher.Form>
              </div>
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Every version, newest first. "Make live" on a non-live row is the deploy AND the revert —
 * direction-neutral by design (the undo of a bad ship is making the previous row live).
 */
function VersionHistory({
  releases,
  production,
  others,
  liveEnvNames,
}: {
  releases: ReleaseRow[];
  production: Env | null;
  others: Env[];
  liveEnvNames: Map<string, string[]>;
}) {
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const makeLive = (environmentId: string, releaseId: string) =>
    fetcher.submit(
      { intent: "make-live", environmentId, releaseId },
      { method: "post" },
    );
  const liveInProd = (r: ReleaseRow) =>
    (liveEnvNames.get(r.id) ?? []).includes(production?.name ?? "");

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Version history</CardTitle>
      </CardHeader>
      <CardContent>
        {releases.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No versions yet. Ship from the Overview, or merge a change request in Changes.
          </p>
        ) : (
          <ul className="divide-y rounded-lg border text-sm">
            {releases.map((r) => (
              <li key={r.id} className="flex items-center gap-2 px-4 py-2">
                <span className="w-10 shrink-0 font-semibold">{r.version}</span>
                <span className="flex w-28 shrink-0 items-center gap-1">
                  {(liveEnvNames.get(r.id) ?? []).map((name) =>
                    name === production?.name ? (
                      <Badge key={name}>Live</Badge>
                    ) : (
                      <Badge key={name} variant="outline" className="capitalize">
                        {name}
                      </Badge>
                    ),
                  )}
                </span>
                <code className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                  {r.gitSha.slice(0, 7)}
                </code>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {r.changelog}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {timeAgo(r.createdAt)}
                </span>
                {production && !liveInProd(r) && (
                  <ConfirmDialog
                    trigger={
                      <Button size="sm" variant="secondary" disabled={busy}>
                        Make live
                      </Button>
                    }
                    title={`Make ${r.version} live in ${production.name}?`}
                    description={`This replaces the current live version once ${r.version} is healthy — no rebuild needed, usually seconds. Undo by making the previous version live again.`}
                    confirmLabel="Make live"
                    onConfirm={() => makeLive(production.id, r.id)}
                  />
                )}
                {others.length > 0 && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="sm" variant="ghost" disabled={busy} aria-label="More deploy targets">
                        ⋯
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {others.map((env) => (
                        <DropdownMenuItem
                          key={env.id}
                          onSelect={() => makeLive(env.id, r.id)}
                          className="capitalize"
                        >
                          Make live in {env.name}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
