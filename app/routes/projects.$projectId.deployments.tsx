/**
 * Versions — the deploy surface (Deploy pillar, M2 + M5.6/M5.7 — PRD §7.4/§7.7).
 *
 * The mental model: SHIP makes versions (Overview); DEPLOY places them (this page). An agent
 * has immutable versions; environments are independent, user-defined peers and each runs
 * exactly ONE version — "running on staging" is a per-environment fact, not a global "live"
 * state. Deploying any version — new or old — to an environment is a clean cutover once the
 * new instance is healthy, so rollback is just deploying an older version again (image
 * reused, no rebuild).
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

    if (intent === "deploy-version" || intent === "retry") {
      // Both are a cutover deploy of a chosen release into a chosen environment;
      // deploy-version rides the rollback job (image reuse — an already-built version
      // starts in seconds), a retry re-runs the forward deploy. queueDeploy creates the
      // row in `queued` BEFORE enqueueing so the click has an immediately visible
      // result; the worker takes it to building → running/failed.
      ensureWorkerStarted();
      await queueDeploy({
        environmentId: String(form.get("environmentId")),
        releaseId: String(form.get("releaseId")),
        rollback: intent === "deploy-version",
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
type EnvState = { env: Env; deployments: DeploymentRow[] };

const IN_FLIGHT = new Set(["queued", "pending", "building"]);

/** The deployment an environment is currently running (post-M5.6 there is at most one). */
function runningOf(deployments: DeploymentRow[]): DeploymentRow | undefined {
  return deployments.find((d) => d.status === "live");
}

export default function Versions({ loaderData, actionData }: Route.ComponentProps) {
  const { project, roster, activeAgent, isTeam, releases, envs } = loaderData;
  const base = `/repos/${project.id}`;
  const [params] = useSearchParams();
  // Set when the human just merged a change on the Changes tab — the new version is now
  // here, ready to deploy.
  const justReleased = params.get("released");

  // Progress: while any deployment is queued/building, re-fetch every few seconds so
  // statuses walk queued → building → running/failed without a manual refresh.
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

  // Which environments each release is running on, for the history rows' badges.
  const runningEnvNames = new Map<string, string[]>();
  for (const { env, deployments } of envs) {
    const running = runningOf(deployments);
    if (!running) continue;
    runningEnvNames.set(running.releaseId, [
      ...(runningEnvNames.get(running.releaseId) ?? []),
      env.name,
    ]);
  }

  return (
    <AppShell breadcrumbs={repoCrumbs({ projectId: project.id, repoName: project.name, isTeam: isTeam, agentName: activeAgent, tail: [{ label: "Versions" }] })}>
      <PageHeader
        title={isTeam ? `Versions — ${activeAgent}` : "Versions"}
        description={
          isTeam
            ? "This member's environments and versions. Each environment runs one version; deploy any version — new or old — to any environment."
            : "Each environment runs one version. Deploy any version — new or old — to any environment; rollback is just deploying again."
        }
      />
      <AgentNav base={base} roster={roster} activeAgent={activeAgent} />

      {justReleased && (
        <Alert className="mb-6">
          <AlertTitle>{justReleased} is ready</AlertTitle>
          <AlertDescription>
            Your change was merged and cut as version{" "}
            <span className="font-semibold">{justReleased}</span>. Deploy it to an
            environment from the version history below.
          </AlertDescription>
        </Alert>
      )}

      {actionData?.error && (
        <Alert variant="destructive" className="mb-6">
          <AlertTitle>Action failed</AlertTitle>
          <AlertDescription>{actionData.error}</AlertDescription>
        </Alert>
      )}

      <EnvironmentsCard envs={envs} activeAgent={activeAgent} />

      <VersionHistory
        releases={releases}
        envs={envs}
        runningEnvNames={runningEnvNames}
      />
    </AppShell>
  );
}

/**
 * The environments — independent peers, one identical row each: what's running, in-flight
 * progress, the latest failure (retry/dismiss), and rename/delete. Superseded/stopped
 * deployment rows are deliberately absent — the version history is the durable record.
 */
function EnvironmentsCard({
  envs,
  activeAgent,
}: {
  envs: EnvState[];
  activeAgent: string;
}) {
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const error =
    fetcher.data && "error" in fetcher.data ? fetcher.data.error : null;

  return (
    <Card className="mb-6">
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
            description="A separate place to run this agent — its own running version and its own environment-scoped secrets. Deploy into it from the version history."
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
            const running = runningOf(deployments);
            const pending = deployments.find((d) => IN_FLIGHT.has(d.status));
            const failed = deployments.find((d) => d.status === "failed");
            const failedCount = deployments.filter((d) => d.status === "failed").length;
            return (
              <li key={env.id} className="px-4 py-2">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="min-w-32 font-medium">{env.name}</span>
                  {running ? (
                    <>
                      <span className="font-semibold">{running.version}</span>
                      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                        {running.gitSha.slice(0, 7)}
                      </code>
                      <span className="text-muted-foreground">
                        deployed {timeAgo(running.createdAt)}
                      </span>
                      {running.url && (
                        <a href={running.url} className="underline underline-offset-4">
                          open
                        </a>
                      )}
                    </>
                  ) : (
                    <span className="text-muted-foreground">
                      Nothing deployed — use Ship on the Overview, or Deploy a version
                      below.
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
                      description={`Stops anything running here and permanently deletes this environment's deployment history and environment-scoped secrets. Agent-wide secrets and versions are untouched.${running ? ` ${running.version} is running here and will be taken down.` : ""}`}
                      confirmLabel="Delete"
                      onConfirm={() =>
                        fetcher.submit(
                          { intent: "env-delete", environmentId: env.id },
                          { method: "post" },
                        )
                      }
                    />
                  </span>
                </div>
                {pending && (
                  <p className="mt-1 text-sm text-muted-foreground">
                    {pending.version}{" "}
                    {pending.status === "building" ? "building" : "queued"}… switches
                    over once healthy{running ? `; ${running.version} keeps serving` : ""}.
                  </p>
                )}
                {failed && (
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-destructive">
                    <span>
                      {failed.version} failed to deploy
                      {running ? ` — ${running.version} still running` : ""}
                    </span>
                    {failed.errorDetail && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="cursor-help text-xs underline underline-offset-2">
                            why?
                          </span>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-sm">
                          {failed.errorDetail}
                        </TooltipContent>
                      </Tooltip>
                    )}
                    <fetcher.Form method="post">
                      <input type="hidden" name="intent" value="retry" />
                      <input type="hidden" name="environmentId" value={env.id} />
                      <input type="hidden" name="releaseId" value={failed.releaseId} />
                      <Button type="submit" size="sm" variant="ghost" disabled={busy}>
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
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

/**
 * Every version, newest first, badged with the environments it's running on. "Deploy" is
 * deliberately direction-neutral — deploying an older version IS the rollback (cutover on
 * health; a built image starts in seconds).
 */
function VersionHistory({
  releases,
  envs,
  runningEnvNames,
}: {
  releases: ReleaseRow[];
  envs: EnvState[];
  runningEnvNames: Map<string, string[]>;
}) {
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const deploy = (environmentId: string, releaseId: string) =>
    fetcher.submit(
      { intent: "deploy-version", environmentId, releaseId },
      { method: "post" },
    );

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
                <span className="flex shrink-0 items-center gap-1">
                  {(runningEnvNames.get(r.id) ?? []).map((name) => (
                    <Badge key={name} variant="secondary">
                      {name}
                    </Badge>
                  ))}
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
                <DeployControl release={r} envs={envs} busy={busy} onDeploy={deploy} />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The per-version deploy affordance. One environment: a plain Deploy button (hidden when
 * the version is already running there — the badge says so). Several: one "Deploy ▾" menu;
 * environments already running the version show as checked and disabled. Every deploy
 * confirms — the dialog names the target (the realistic multi-env mistake) and teaches
 * that switching back is just another deploy.
 */
function DeployControl({
  release,
  envs,
  busy,
  onDeploy,
}: {
  release: ReleaseRow;
  envs: EnvState[];
  busy: boolean;
  onDeploy: (environmentId: string, releaseId: string) => void;
}) {
  const [target, setTarget] = useState<EnvState | null>(null);
  const runningHere = (s: EnvState) =>
    runningOf(s.deployments)?.releaseId === release.id;

  const confirmFor = (s: EnvState) => {
    const current = runningOf(s.deployments);
    return {
      title: `Deploy ${release.version} to ${s.env.name}?`,
      description: current
        ? `${s.env.name} switches to ${release.version} once it's healthy; ${current.version} keeps serving until then. To switch back, deploy ${current.version} again.`
        : `${release.version} will start running on ${s.env.name}.`,
    };
  };

  if (envs.length === 1) {
    const only = envs[0];
    if (runningHere(only)) return null;
    const copy = confirmFor(only);
    return (
      <ConfirmDialog
        trigger={
          <Button size="sm" variant="secondary" disabled={busy}>
            Deploy
          </Button>
        }
        title={copy.title}
        description={copy.description}
        confirmLabel="Deploy"
        variant="default"
        onConfirm={() => onDeploy(only.env.id, release.id)}
      />
    );
  }

  const everywhere = envs.every(runningHere);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="secondary" disabled={busy || everywhere}>
            Deploy ▾
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {envs.map((s) =>
            runningHere(s) ? (
              <DropdownMenuItem key={s.env.id} disabled>
                ✓ Running on {s.env.name}
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem key={s.env.id} onSelect={() => setTarget(s)}>
                Deploy to {s.env.name}
              </DropdownMenuItem>
            ),
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {target && (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setTarget(null);
          }}
          title={confirmFor(target).title}
          description={confirmFor(target).description}
          confirmLabel="Deploy"
          variant="default"
          onConfirm={() => {
            onDeploy(target.env.id, release.id);
            setTarget(null);
          }}
        />
      )}
    </>
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
