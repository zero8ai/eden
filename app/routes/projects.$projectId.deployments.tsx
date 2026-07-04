/**
 * Versions — the deploy surface (Deploy pillar, M2 + M6/M5.7 — PRD §7.4/§7.7).
 *
 * The mental model is deliberately small: an agent has VERSIONS; exactly ONE version is live
 * per environment. Environments are user-defined (create/rename/delete below; every member
 * keeps at least one) and the member's PRIMARY — its first — is the page's hero; the version
 * history lets any past version be made live again in one click (fast rollback — the image
 * is reused, no rebuild). Shipping a NEW version happens on the Overview (Ship) or via
 * Changes → merge; this page is where you see and move what's live.
 */
import { authkitLoader, withAuth } from "@workos-inc/authkit-react-router";
import { useEffect, useRef, useState } from "react";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { clearFailedDeployments, listDeployments, queueDeploy } from "~/deploy/controller.server";
import {
  createEnvironment,
  deleteEnvironment,
  renameEnvironment,
} from "~/deploy/environments.server";
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

  try {
    // ── Environment CRUD (M5.7: environments are user-defined, per member) ──
    if (intent === "env-create") {
      const { active } = await resolveAgentContext(
        project.id,
        String(form.get("agent") ?? "") || null,
      );
      await createEnvironment({
        projectId: project.id,
        agentId: active.id,
        name: String(form.get("name") ?? ""),
        orgId: project.orgId,
        createdBy: auth.user.id,
      });
      return { ok: true as const };
    }
    if (intent === "env-rename") {
      await renameEnvironment({
        environmentId: String(form.get("environmentId")),
        name: String(form.get("name") ?? ""),
        orgId: project.orgId,
        createdBy: auth.user.id,
      });
      return { ok: true as const };
    }
    if (intent === "env-delete") {
      await deleteEnvironment({
        environmentId: String(form.get("environmentId")),
        orgId: project.orgId,
        createdBy: auth.user.id,
      });
      return { ok: true as const };
    }

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

  // The member's PRIMARY environment is its first (creation order; environments are
  // user-defined — no name is special). It gets the hero card; the rest live below.
  const primary = envs[0];
  const others = envs.filter((e) => e !== primary);
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

      {primary && (
        <PrimaryCard env={primary.env} deployments={primary.deployments} />
      )}

      <VersionHistory
        releases={releases}
        primary={primary?.env ?? null}
        others={others.map((o) => o.env)}
        liveEnvNames={liveEnvNames}
      />

      <EnvironmentsCard envs={envs} primaryId={primary?.env.id} activeAgent={activeAgent} />
    </AppShell>
  );
}

/**
 * The hero: what the primary environment is running right now, plus in-flight progress and
 * the latest failure (with retry). Superseded/stopped rows are deliberately absent — the
 * version history is the durable record, old deployment rows are infrastructure.
 */
function PrimaryCard({ env, deployments }: { env: Env; deployments: DeploymentRow[] }) {
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
        <CardTitle className="text-base">{env.name}</CardTitle>
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
  primary,
  others,
  liveEnvNames,
}: {
  releases: ReleaseRow[];
  primary: Env | null;
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
  const liveInPrimary = (r: ReleaseRow) =>
    (liveEnvNames.get(r.id) ?? []).includes(primary?.name ?? "");

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
                    name === primary?.name ? (
                      <Badge key={name}>Live</Badge>
                    ) : (
                      <Badge key={name} variant="outline">
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
                {primary && !liveInPrimary(r) && (
                  <ConfirmDialog
                    trigger={
                      <Button size="sm" variant="secondary" disabled={busy}>
                        Make live
                      </Button>
                    }
                    title={`Make ${r.version} live in ${primary.name}?`}
                    description={`This replaces the current live version once ${r.version} is healthy — no rebuild needed, usually seconds. Undo by making the previous version live again.`}
                    confirmLabel="Make live"
                    onConfirm={() => makeLive(primary.id, r.id)}
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

/**
 * Environment management (M5.7): environments are user-defined, per member. One row per
 * env with its live version, plus rename/delete and a create dialog. The first (primary)
 * env is badged — it's the default Ship target and the hero card above. Delete stops
 * anything running and destroys the env's deploy history + env-scoped secrets (the FK
 * cascade), so the confirm spells that out; a member's last environment can't be deleted.
 */
function EnvironmentsCard({
  envs,
  primaryId,
  activeAgent,
}: {
  envs: { env: Env; deployments: DeploymentRow[] }[];
  primaryId?: string;
  activeAgent: string;
}) {
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const error =
    fetcher.data && "error" in fetcher.data ? fetcher.data.error : null;

  return (
    <Card className="mt-6">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Environments</CardTitle>
          <EnvNameDialog
            intent="env-create"
            agent={activeAgent}
            trigger={
              <Button size="sm" variant="outline" disabled={busy}>
                New environment
              </Button>
            }
            title="New environment"
            description="A separate place to run this agent — its own live version and its own environment-scoped secrets. Deploy into it from the version history's ⋯ menu."
            confirmLabel="Create"
          />
        </div>
      </CardHeader>
      <CardContent>
        {error && (
          <Alert variant="destructive" className="mb-4">
            <AlertTitle>Couldn&rsquo;t update environments</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <ul className="divide-y rounded-lg border text-sm">
          {envs.map(({ env, deployments }) => {
            const live = liveOf(deployments);
            const pending = deployments.find((d) => IN_FLIGHT.has(d.status));
            return (
              <li key={env.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
                <span className="min-w-32 font-medium">{env.name}</span>
                {env.id === primaryId && <Badge variant="secondary">primary</Badge>}
                {live ? (
                  <>
                    <span className="font-semibold">{live.version}</span>
                    <Badge>Live</Badge>
                    <span className="text-muted-foreground">{timeAgo(live.createdAt)}</span>
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
                <span className="ml-auto flex items-center gap-1">
                  <EnvNameDialog
                    intent="env-rename"
                    environmentId={env.id}
                    initialName={env.name}
                    trigger={
                      <Button size="sm" variant="ghost" disabled={busy}>
                        Rename
                      </Button>
                    }
                    title={`Rename ${env.name}?`}
                    description="Deploys, secrets, and history stay attached — only the name changes. On a team, Ship targets members' environments by name."
                    confirmLabel="Rename"
                  />
                  <ConfirmDialog
                    trigger={
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                        disabled={busy}
                      >
                        Delete
                      </Button>
                    }
                    title={`Delete environment "${env.name}"?`}
                    description={`Stops anything running here and permanently deletes this environment's deployment history and environment-scoped secrets. Agent-wide secrets and versions are untouched.${live ? ` ${live.version} is live here right now and will be taken down.` : ""}`}
                    confirmLabel="Delete"
                    onConfirm={() =>
                      fetcher.submit(
                        { intent: "env-delete", environmentId: env.id },
                        { method: "post" },
                      )
                    }
                  />
                </span>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

/** Shared name dialog for env create/rename — one text field, posts `intent` + `name`. */
function EnvNameDialog({
  intent,
  trigger,
  title,
  description,
  confirmLabel,
  environmentId,
  initialName,
  agent,
}: {
  intent: "env-create" | "env-rename";
  trigger: React.ReactNode;
  title: string;
  description: string;
  confirmLabel: string;
  environmentId?: string;
  initialName?: string;
  agent?: string;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(initialName ?? "");
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const error = fetcher.data && "error" in fetcher.data ? fetcher.data.error : null;
  // Stay open until OUR submission settles — success closes, an error (e.g. duplicate
  // name) shows inline so the human can fix the name and retry.
  const submitted = useRef(false);
  useEffect(() => {
    if (busy || !submitted.current) return;
    submitted.current = false;
    if (fetcher.data && "ok" in fetcher.data && fetcher.data.ok) {
      setOpen(false);
      if (intent === "env-create") setName("");
    }
  }, [busy, fetcher.data, intent]);
  const submit = () => {
    if (!name.trim()) return;
    submitted.current = true;
    fetcher.submit(
      {
        intent,
        name: name.trim(),
        ...(environmentId ? { environmentId } : {}),
        ...(agent ? { agent } : {}),
      },
      { method: "post" },
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="space-y-1.5">
          <Label htmlFor={`env-name-${intent}-${environmentId ?? "new"}`}>Name</Label>
          <Input
            id={`env-name-${intent}-${environmentId ?? "new"}`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="staging"
            autoFocus
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!name.trim() || busy}>
            {busy ? "Saving…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
