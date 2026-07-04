/**
 * Deployment — the whole pipeline on one tab (M5.8; Deploy + Review pillars, PRD §7.3/§7.4/§7.7).
 *
 * SHIP makes versions (Overview); this tab is everything after an edit exists:
 *   staged changes → change request → merge (cuts a version) → environments running versions.
 *
 * Two views over one module (route ids `deployment` + `member-deployment`):
 *  - MEMBER pipeline (single-agent repos at /repos/:id/deployment; team members at
 *    /repos/:id/agents/:name/deployment): the member's staged drafts (+ shared ones, which
 *    affect every member), repo-wide change requests, then the member's environments and
 *    version history with direction-neutral Deploy.
 *  - REPO rollup (team repos at /repos/:id/deployment): all staged drafts grouped by member,
 *    change requests + Merge (a merge cuts a version for every member), and a per-member
 *    latest-version table linking into each member's pipeline.
 */
import { authkitLoader, withAuth } from "@workos-inc/authkit-react-router";
import { useEffect, useRef, useState } from "react";
import {
  Form,
  Link,
  redirect,
  useFetcher,
  useNavigation,
  useRevalidator,
  useSearchParams,
  useSubmit,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { ConfirmDialog } from "~/components/confirm-dialog";
import { AgentNav, AppShell, PageHeader, repoCrumbs, type NavLevel } from "~/components/shell";
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
import {
  clearFailedDeployments,
  ensureReleasesForCommit,
  listDeployments,
  queueDeploy,
} from "~/deploy/controller.server";
import {
  createEnvironment,
  deleteEnvironment,
  renameEnvironment,
} from "~/deploy/environments.server";
import { listAgentEnvironments, listReleases } from "~/db/queries.server";
import { discardDrafts, listDrafts, publishDrafts } from "~/drafts/drafts.server";
import { closePullRequest, listOpenChanges, mergePullRequest } from "~/github/write.server";
import { ensureWorkerStarted } from "~/jobs/worker.server";
import { contextPath } from "~/lib/paths";
import { timeAgo } from "~/lib/time";
import {
  agentFromParams,
  agentParamRedirect,
  resolveAgentContext,
} from "~/project/agent-context.server";
import { requireProject, requireRepo } from "~/project/guard.server";
import type {
  DeploymentWithRelease,
  DraftChange,
  Environment,
  Release,
} from "~/data/ports";
import type { ConnectedProject } from "~/project/guard.server";
import type { OpenChange } from "~/github/write.server";
import type { Route } from "./+types/projects.$projectId.deployments";

/** One shape for both views so the loader's branches unify (member fields empty on repo). */
interface DeploymentData {
  project: ConnectedProject;
  roster: { name: string }[];
  activeAgent: string;
  isTeam: boolean;
  level: NavLevel;
  view: "repo" | "member";
  drafts: (DraftChange & { shared: boolean })[];
  changes: OpenChange[];
  releases: Release[];
  envs: { env: Environment; deployments: DeploymentWithRelease[] }[];
  draftGroups: { owner: string; drafts: DraftChange[] }[];
  members: {
    name: string;
    latest: { version: string; gitSha: string; createdAt: Date } | null;
  }[];
}

export const loader = (args: LoaderFunctionArgs) =>
  authkitLoader(
    args,
    async ({ auth }): Promise<DeploymentData> => {
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
      const agentName = agentFromParams(args.params);
      if (!agentName) {
        const legacy = agentParamRedirect(args.request, project.id);
        if (legacy) throw legacy;
      }
      const { roster, active, isTeam } = await resolveAgentContext(
        project.id,
        agentName,
      );
      const level: NavLevel = agentName ? "member" : isTeam ? "repo" : "single";
      const view = level === "repo" ? ("repo" as const) : ("member" as const);

      const [allDrafts, changes, releaseRows] = await Promise.all([
        listDrafts(project.id),
        listOpenChanges(project.repoInstallationId, {
          owner: project.repoOwner,
          repo: project.repoName,
        }),
        listReleases(project.id),
      ]);

      if (view === "repo") {
        // Team rollup: drafts grouped by owning member (null = shared), latest version per
        // member linking into their pipeline.
        const nameById = new Map(roster.map((a) => [a.id, a.name]));
        const groups = new Map<string, typeof allDrafts>();
        for (const d of allDrafts) {
          const key = d.agentId ? (nameById.get(d.agentId) ?? "shared") : "shared";
          groups.set(key, [...(groups.get(key) ?? []), d]);
        }
        const members = roster.map((a) => {
          const latest = releaseRows.find((r) => r.agentId === a.id);
          return {
            name: a.name,
            latest: latest
              ? { version: latest.version, gitSha: latest.gitSha, createdAt: latest.createdAt }
              : null,
          };
        });
        return {
          project,
          roster: roster.map((a) => ({ name: a.name })),
          activeAgent: active.name,
          isTeam,
          level,
          view,
          draftGroups: [...groups.entries()].map(([owner, drafts]) => ({
            owner,
            drafts,
          })),
          changes,
          members,
          drafts: [],
          releases: [],
          envs: [],
        };
      }

      // Member pipeline: this member's drafts + shared ones, its envs + versions.
      const drafts = allDrafts
        .filter((d) => d.agentId === active.id || d.agentId === null)
        .map((d) => ({ ...d, shared: d.agentId === null }));
      const envRows = await listAgentEnvironments(active.id);
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
        level,
        view,
        drafts,
        changes,
        releases: releaseRows.filter((r) => r.agentId === active.id),
        envs,
        draftGroups: [],
        members: [],
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
  const back = `${contextPath(project.id, agentFromParams(args.params))}/deployment`;
  const repo = { owner: project.repoOwner, repo: project.repoName };

  try {
    // ── Change-set intents (repo-scoped; from either view) ──
    if (intent === "publish") {
      const paths = form.getAll("path").map(String);
      const title = String(form.get("title") ?? "");
      await publishDrafts({ project, paths, title, createdBy: auth.user.id });
      throw redirect(back);
    }
    if (intent === "discard") {
      await discardDrafts(project.id, [String(form.get("path"))]);
      throw redirect(back);
    }
    if (intent === "delete-change") {
      const pullNumber = Number(form.get("pullNumber"));
      const branch = String(form.get("branch") ?? "") || undefined;
      if (!pullNumber) return { error: "Missing change to delete." };
      await closePullRequest(project.repoInstallationId, repo, pullNumber, branch);
      throw redirect(back);
    }
    if (intent === "merge") {
      const pullNumber = Number(form.get("pullNumber"));
      const branch = String(form.get("branch") ?? "") || undefined;
      const title = String(form.get("title") ?? "");
      if (!pullNumber) return { error: "Missing change to merge." };
      // Merge → one commit on the default branch (the version identity) → a Release per
      // roster member (idempotent with the webhook path; team merges are atomic, §7.9).
      const { mergeSha } = await mergePullRequest(
        project.repoInstallationId,
        repo,
        pullNumber,
        branch,
      );
      const results = await ensureReleasesForCommit({
        projectId: project.id,
        gitSha: mergeSha,
        changelog: `#${pullNumber} ${title}`.trim(),
        createdBy: auth.user.id,
      });
      const version = results[0]?.release.version ?? "";
      throw redirect(`${back}?released=${encodeURIComponent(version)}`);
    }

    // ── Environment CRUD (M5.7: user-defined, per member) ──
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

    // ── Deploys ──
    if (intent === "deploy-version" || intent === "retry") {
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
  return [{ title: "Deployment · Eden" }];
}

type LoaderData = Route.ComponentProps["loaderData"];
type Env = LoaderData["envs"][number]["env"];
type DeploymentRow = LoaderData["envs"][number]["deployments"][number];
type ReleaseRow = LoaderData["releases"][number];
type EnvState = { env: Env; deployments: DeploymentRow[] };
type DraftRow = LoaderData["drafts"][number];
type ChangeRow = LoaderData["changes"][number];

const IN_FLIGHT = new Set(["queued", "pending", "building"]);

/** The deployment an environment is currently running (post-M5.6 there is at most one). */
function runningOf(deployments: DeploymentRow[]): DeploymentRow | undefined {
  return deployments.find((d) => d.status === "live");
}

export default function Deployment({ loaderData, actionData }: Route.ComponentProps) {
  const { project, roster, activeAgent, isTeam, level, view } = loaderData;
  const memberBase = contextPath(project.id, level === "member" ? activeAgent : null);
  const [params] = useSearchParams();
  const justReleased = params.get("released");

  // Progress: while any deployment is queued/building, re-fetch every few seconds.
  const revalidator = useRevalidator();
  const inFlight = loaderData.envs.some(({ deployments }) =>
    deployments.some((d) => IN_FLIGHT.has(d.status)),
  );
  useEffect(() => {
    if (!inFlight) return;
    const timer = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 3000);
    return () => clearInterval(timer);
  }, [inFlight, revalidator]);

  return (
    <AppShell
      breadcrumbs={repoCrumbs({
        projectId: project.id,
        repoName: project.name,
        isTeam: level === "member",
        agentName: activeAgent,
        tail: [{ label: "Deployment" }],
      })}
    >
      <PageHeader
        title={level === "member" ? `Deployment — ${activeAgent}` : "Deployment"}
        description={
          view === "repo"
            ? "The team's pipeline: staged changes by member, change requests (merging cuts a version for every member), and each member's latest version."
            : "The pipeline for this agent: staged changes become a change request; merging cuts a version; each environment runs one version. Rollback is just deploying an older version again."
        }
      />
      <AgentNav
        base={memberBase}
        level={level}
        roster={roster}
        activeAgent={level === "member" ? activeAgent : undefined}
      />

      {justReleased && (
        <Alert className="mb-6">
          <AlertTitle>{justReleased} is ready</AlertTitle>
          <AlertDescription>
            {view === "repo"
              ? `The merge cut a new version for every member. Deploy it from each member's Deployment tab.`
              : `Your change was merged and cut as version ${justReleased}. Deploy it to an environment from the version history below.`}
          </AlertDescription>
        </Alert>
      )}

      {actionData?.error && (
        <Alert variant="destructive" className="mb-6">
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription className="whitespace-pre-wrap">
            {actionData.error}
          </AlertDescription>
        </Alert>
      )}

      {view === "repo" ? (
        <TeamRollup loaderData={loaderData} />
      ) : (
        <MemberPipeline loaderData={loaderData} />
      )}
    </AppShell>
  );
}

/* ────────────────────────────── member pipeline ────────────────────────────── */

function MemberPipeline({ loaderData }: { loaderData: LoaderData }) {
  const { drafts, changes, releases, envs, activeAgent, isTeam } = loaderData;

  return (
    <>
      <StagedChangesCard drafts={drafts} isTeam={isTeam} />
      <ChangeRequests changes={changes} isTeam={isTeam} />
      <EnvironmentsCard envs={envs} activeAgent={activeAgent} />
      <VersionHistory releases={releases} envs={envs} />
    </>
  );
}

/** Stage 1: this member's unpublished drafts (+ shared files, which affect everyone). */
function StagedChangesCard({ drafts, isTeam }: { drafts: DraftRow[]; isTeam: boolean }) {
  const navigation = useNavigation();
  const submit = useSubmit();
  const busy = navigation.state !== "idle" && navigation.formData != null;
  const activeIntent = busy ? String(navigation.formData!.get("intent") ?? "") : null;

  return (
    <Card className="mb-6">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <CardTitle className="text-base">Staged changes</CardTitle>
          <Badge variant="secondary">{drafts.length}</Badge>
        </div>
      </CardHeader>
      <CardContent>
        {drafts.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing staged. Edits you save — instructions, model, any agent file — collect
            here until you publish them (or Ship from the Overview).
          </p>
        ) : (
          <Form method="post">
            <input type="hidden" name="intent" value="publish" />
            <ul className="divide-y rounded-lg border text-sm">
              {drafts.map((d) => (
                <li key={d.id} className="flex items-center gap-3 px-3 py-2">
                  <input
                    type="checkbox"
                    name="path"
                    value={d.path}
                    defaultChecked
                    className="size-4 accent-primary"
                    aria-label={`Include ${d.path}`}
                  />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">
                    {d.path}
                  </span>
                  {d.shared && isTeam && (
                    <Badge variant="outline">shared · affects all members</Badge>
                  )}
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {timeAgo(d.updatedAt)}
                  </span>
                  <ConfirmDialog
                    trigger={
                      <Button variant="ghost" size="sm" type="button" disabled={busy}>
                        Discard
                      </Button>
                    }
                    title={`Discard staged change to ${d.path}?`}
                    description="The unpublished edit is deleted. The file itself is untouched — only the staged draft is lost."
                    confirmLabel="Discard"
                    onConfirm={() =>
                      submit({ intent: "discard", path: d.path }, { method: "post" })
                    }
                  />
                </li>
              ))}
            </ul>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Input
                name="title"
                placeholder="Change title (optional)"
                className="h-9 w-72"
              />
              <Button type="submit" disabled={busy}>
                {activeIntent === "publish"
                  ? "Checking build & publishing…"
                  : "Publish selected as change request"}
              </Button>
            </div>
          </Form>
        )}
      </CardContent>
    </Card>
  );
}

/** Stage 2: open change requests (repo-wide — a merge cuts a version for every member). */
function ChangeRequests({ changes, isTeam }: { changes: ChangeRow[]; isTeam: boolean }) {
  const navigation = useNavigation();
  const busy = navigation.state !== "idle" && navigation.formData != null;
  const activeIntent = busy ? String(navigation.formData!.get("intent") ?? "") : null;
  const mergingNumber =
    activeIntent === "merge" ? Number(navigation.formData!.get("pullNumber")) : null;
  const deletingNumber =
    activeIntent === "delete-change"
      ? Number(navigation.formData!.get("pullNumber"))
      : null;

  if (changes.length === 0) return null;
  return (
    <div className="mb-6">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-lg font-semibold">Open change requests</h2>
        {isTeam && (
          <span className="text-xs text-muted-foreground">
            repo-wide — merging cuts a version for every member
          </span>
        )}
      </div>
      <div className="space-y-4">
        {changes.map((c) => (
          <ChangeCard
            key={c.number}
            change={c}
            busy={busy}
            merging={mergingNumber === c.number}
            deleting={deletingNumber === c.number}
          />
        ))}
      </div>
    </div>
  );
}

function ChangeCard({
  change,
  busy,
  merging,
  deleting,
}: {
  change: ChangeRow;
  busy: boolean;
  merging: boolean;
  deleting: boolean;
}) {
  const submit = useSubmit();
  const conflicted = change.mergeable === false;
  const checking = change.mergeable === null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="text-base">
              {change.title}{" "}
              <span className="font-mono text-sm font-normal text-muted-foreground">
                #{change.number}
              </span>
            </CardTitle>
            {change.body && (
              <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                {change.body}
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <MergeabilityBadge conflicted={conflicted} checking={checking} />
            <ConfirmDialog
              trigger={
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  disabled={busy}
                >
                  {deleting ? "Deleting…" : "Delete"}
                </Button>
              }
              title={`Delete change request #${change.number}?`}
              description="It will be closed without merging and its staged edits discarded. GitHub keeps the closed change request, so this can be restored there if needed."
              confirmLabel="Delete"
              onConfirm={() =>
                submit(
                  {
                    intent: "delete-change",
                    pullNumber: String(change.number),
                    branch: change.branch,
                  },
                  { method: "post" },
                )
              }
            />
            <Form method="post">
              <input type="hidden" name="intent" value="merge" />
              <input type="hidden" name="pullNumber" value={change.number} />
              <input type="hidden" name="branch" value={change.branch} />
              <input type="hidden" name="title" value={change.title} />
              <Button type="submit" size="sm" disabled={busy || conflicted}>
                {merging ? "Merging…" : "Merge"}
              </Button>
            </Form>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {change.files.length === 0 ? (
          <p className="text-sm text-muted-foreground">No file changes.</p>
        ) : (
          <ul className="divide-y rounded-lg border text-sm">
            {change.files.map((f) => (
              <li key={f.path} className="flex items-center justify-between gap-3 px-3 py-1.5">
                <span className="truncate font-mono text-xs">{f.path}</span>
                <span className="flex shrink-0 items-center gap-2 font-mono text-xs">
                  <span className="text-emerald-600 dark:text-emerald-400">+{f.additions}</span>
                  <span className="text-destructive">−{f.deletions}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
        {conflicted && (
          <p className="mt-3 text-xs text-destructive">
            Conflicts with the current default branch — re-stage the files from a fresh edit.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function MergeabilityBadge({
  conflicted,
  checking,
}: {
  conflicted: boolean;
  checking: boolean;
}) {
  if (checking) return <Badge variant="secondary">checking…</Badge>;
  if (conflicted) return <Badge variant="destructive">conflicts</Badge>;
  return <Badge variant="outline">ready</Badge>;
}

/* ────────────────────────────── team rollup ────────────────────────────── */

function TeamRollup({ loaderData }: { loaderData: LoaderData }) {
  const { project, draftGroups, changes, members } = loaderData;
  const totalDrafts = draftGroups.reduce((n, g) => n + g.drafts.length, 0);

  return (
    <>
      <Card className="mb-6">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <CardTitle className="text-base">Staged changes</CardTitle>
            <Badge variant="secondary">{totalDrafts}</Badge>
          </div>
        </CardHeader>
        <CardContent>
          {totalDrafts === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing staged anywhere. Members' edits collect here until published.
            </p>
          ) : (
            <div className="space-y-4">
              {draftGroups.map((g) => (
                <div key={g.owner}>
                  <p className="mb-1 text-sm font-medium">
                    {g.owner === "shared" ? (
                      <>
                        shared{" "}
                        <span className="font-normal text-muted-foreground">
                          · affects all members
                        </span>
                      </>
                    ) : (
                      <Link
                        to={`${contextPath(project.id, g.owner)}/deployment`}
                        className="underline-offset-4 hover:underline"
                      >
                        {g.owner}
                      </Link>
                    )}
                  </p>
                  <ul className="divide-y rounded-lg border text-sm">
                    {g.drafts.map((d) => (
                      <li key={d.id} className="flex items-center gap-3 px-3 py-1.5">
                        <span className="min-w-0 flex-1 truncate font-mono text-xs">
                          {d.path}
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {timeAgo(d.updatedAt)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              <p className="text-xs text-muted-foreground">
                Publish from a member&rsquo;s Deployment tab (or Ship from their Overview).
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <ChangeRequests changes={changes} isTeam />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Members</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="divide-y rounded-lg border text-sm">
            {members.map((m) => (
              <li key={m.name} className="flex flex-wrap items-center gap-3 px-4 py-2">
                <Link
                  to={`${contextPath(project.id, m.name)}/deployment`}
                  className="min-w-32 font-medium underline-offset-4 hover:underline"
                >
                  {m.name}
                </Link>
                {m.latest ? (
                  <>
                    <span className="font-semibold">{m.latest.version}</span>
                    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                      {m.latest.gitSha.slice(0, 7)}
                    </code>
                    <span className="text-muted-foreground">
                      {timeAgo(m.latest.createdAt)}
                    </span>
                  </>
                ) : (
                  <span className="text-muted-foreground">no versions yet</span>
                )}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </>
  );
}

/* ─────────────────────── environments + versions (member) ─────────────────────── */

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
}: {
  releases: ReleaseRow[];
  envs: EnvState[];
}) {
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const deploy = (environmentId: string, releaseId: string) =>
    fetcher.submit(
      { intent: "deploy-version", environmentId, releaseId },
      { method: "post" },
    );
  // Which environments each release is running on, for the rows' badges.
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
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Version history</CardTitle>
      </CardHeader>
      <CardContent>
        {releases.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No versions yet. Ship from the Overview, or merge a change request above.
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
