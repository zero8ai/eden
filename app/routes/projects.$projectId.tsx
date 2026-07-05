/**
 * Project overview — the repo-backed config surface for the ACTIVE roster member (PRD §7.9).
 *
 * Single-agent repos are teams of one: no switcher, the surface reads from `agent/` exactly
 * as before the split. Team repos get a member switcher (AgentNav), per-member surfaces
 * rooted at `agents/<member>/agent/`, and roster CRUD — add/remove members land as
 * change-sets (branch → PR) like every other edit; the roster row itself syncs on merge.
 */
import { authkitLoader, withAuth } from "@workos-inc/authkit-react-router";
import { X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Form,
  Link,
  data,
  redirect,
  useFetcher,
  useNavigation,
  useRevalidator,
  useSubmit,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { NewResourceDialog } from "~/components/new-resource-dialog";
import {
  AgentNav,
  AppShell,
  PageHeader,
  SectionHeader,
  repoCrumbs,
} from "~/components/shell";
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
  listAgentEnvironments,
  syncProjectAgents,
  withPreservedNames,
  type Agent,
} from "~/db/queries.server";
import { listDeployments, queueDeploy } from "~/deploy/controller.server";
import { shipHead, shipStagedChanges } from "~/deploy/ship.server";
import { listDrafts } from "~/drafts/drafts.server";
import { readModel } from "~/eve/agentModule";
import { buildAgentConfig, detectAgentRoots } from "~/eve/parse";
import { RESOURCE_KINDS, sandboxPath, slugifyResourceName } from "~/eve/templates";
import { AGENT_CATEGORIES, type AgentConfig } from "~/eve/types";
import { memberScaffold } from "~/github/create.server";
import { getAgentSource } from "~/github/cached.server";
import { proposeChange } from "~/github/write.server";
import { ensureWorkerStarted } from "~/jobs/worker.server";
import { contextPath } from "~/lib/paths";
import { timeAgo } from "~/lib/time";
import {
  agentFromParams,
  agentParamRedirect,
  resolveAgentContext,
} from "~/project/agent-context.server";
import { requireProject, requireRepo } from "~/project/guard.server";
import type { Project } from "~/db/queries.server";
import type { Route } from "./+types/projects.$projectId";

/** Roster card data for the team landing view. */
interface MemberSummary {
  name: string;
  model: string | null;
  tools: number;
  skills: number;
  schedules: number;
  channels: number;
}

/** One affected member's deploy progress after a Ship (drives the progress banner). */
interface ShipStatusRow {
  agentName: string;
  version: string;
  status: string;
  url: string | null;
  errorDetail: string | null;
  environmentId: string;
  releaseId: string;
}

interface ProjectView {
  project: Project;
  roster: { name: string }[];
  active: Pick<Agent, "name" | "root"> | null;
  isTeam: boolean;
  /** True when the repo uses the team layout (agents/*) — enables roster CRUD. */
  teamLayout: boolean;
  /**
   * Which level of the hierarchy this request renders: the TEAM landing (roster-first,
   * no `?agent=`) or one MEMBER's config surface. Single-agent repos are always "member".
   */
  view: "team" | "member";
  /** Team landing: one summary per roster member. */
  members: MemberSummary[] | null;
  /** Team landing: whether the "this is a team" intro card was dismissed (cookie). */
  teamIntroDismissed: boolean;
  /** Member view: the active member's parsed config. */
  config: AgentConfig | null;
  error: string | null;
  /** Paths with staged (unpublished) drafts, so the config surface can flag them. */
  draftPaths: string[];
  /** Member view: this member's environment names, for the Ship dialog's target picker. */
  envNames: string[];
  /** Member view: what's running per environment, for the header status line. */
  running: {
    envName: string;
    version: string;
    url: string | null;
    at: string;
  }[];
  /** Deploy progress for a just-shipped commit (?shipped=<sha>&env=<name>&skipped=a,b). */
  ship: { env: string; rows: ShipStatusRow[]; skipped: string[] } | null;
}

/**
 * Persists dismissal of the team-landing intro card (1yr, SameSite=Lax). Read server-side
 * in the loader — same pattern as the theme cookie — so dismissed users never see a flash.
 */
const TEAM_INTRO_COOKIE = "eden-team-intro-dismissed";

export const loader = (args: LoaderFunctionArgs) =>
  authkitLoader(
    args,
    async ({ auth }): Promise<ProjectView> => {
      const project = await requireProject(
        {
          user: auth.user,
          organizationId: auth.organizationId,
          role: auth.role,
        },
        args.params.projectId,
      );

      if (
        !project.repoInstallationId ||
        !project.repoOwner ||
        !project.repoName
      ) {
        return {
          project,
          roster: [],
          active: null,
          isTeam: false,
          teamLayout: false,
          view: "member" as const,
          members: null,
          teamIntroDismissed: false,
          config: null,
          error: "This project has no connected repo.",
          draftPaths: [],
          envNames: [],
          running: [],
          ship: null,
        };
      }

      try {
        const [source, drafts] = await Promise.all([
          getAgentSource(project.repoInstallationId, {
            owner: project.repoOwner,
            repo: project.repoName,
          }),
          listDrafts(project.id),
        ]);

        // Self-heal the roster from the repo (external pushes don't always hit our webhook).
        const requestedAgent = agentFromParams(args.params);
        if (!requestedAgent) {
          const legacy = agentParamRedirect(args.request, project.id);
          if (legacy) throw legacy;
        }
        let { roster, active, isTeam } = await resolveAgentContext(
          project.id,
          requestedAgent,
        );
        const detected = withPreservedNames(
          roster,
          detectAgentRoots(source.paths),
        );
        const known = new Set(roster.map((a) => `${a.name}:${a.root}`));
        if (
          detected.length > 0 &&
          (detected.length !== roster.length ||
            detected.some((d) => !known.has(`${d.name}:${d.root}`)))
        ) {
          await syncProjectAgents(project.id, detected);
          ({ roster, active, isTeam } = await resolveAgentContext(
            project.id,
            requestedAgent,
          ));
        }

        const teamLayout = active.root !== "agent";
        // The hierarchy: a team repo LANDS on the team (roster) view; a member's config
        // surface is a drill-in (?agent=<name>). Single-agent repos go straight to their
        // one member, exactly as before teams existed.
        const view =
          teamLayout && !requestedAgent
            ? ("team" as const)
            : ("member" as const);
        const members =
          view === "team"
            ? roster.map((a) => {
                const c = buildAgentConfig(source, a.root);
                // A staged agent.ts draft wins over the repo value — same rule the
                // member view follows, so the roster badge never lags a model change.
                const draft = drafts.find(
                  (d) => d.path === `${a.root}/agent.ts` && d.content !== null,
                );
                const model = draft?.content
                  ? (readModel(draft.content) ?? c.model)
                  : c.model;
                return {
                  name: a.name,
                  model,
                  tools: c.tools.length,
                  skills: c.skills.length,
                  schedules: c.schedules.length,
                  channels: c.channels.length,
                };
              })
            : null;
        const teamIntroDismissed = new RegExp(
          `(?:^|; )${TEAM_INTRO_COOKIE}=1`,
        ).test(args.request.headers.get("cookie") ?? "");

        // The model shown inline must reflect the newest intent: a staged agent.ts draft
        // wins over the repo value (same rule the editors follow).
        const config =
          view === "member" ? buildAgentConfig(source, active.root) : null;
        const agentTsDraft = drafts.find(
          (d) => d.path === `${active.root}/agent.ts` && d.content !== null,
        );
        if (config && agentTsDraft?.content) {
          config.model = readModel(agentTsDraft.content) ?? config.model;
          config.hasAgentModule = true;
        }

        // Deploy status for the member surface: what's running per environment (header
        // line), the member's environment names (Ship dialog), and — after a Ship —
        // per-member deploy progress for the shipped commit, so the banner survives
        // refreshes (state lives in the DB).
        let envNames: string[] = [];
        let running: ProjectView["running"] = [];
        let ship: ProjectView["ship"] = null;
        if (view === "member") {
          const envs = await listAgentEnvironments(active.id);
          envNames = envs.map((e) => e.name);
          running = (
            await Promise.all(
              envs.map(async (env) => {
                const current = (await listDeployments(env.id)).find(
                  (d) => d.status === "live",
                );
                return current
                  ? {
                      envName: env.name,
                      version: current.version,
                      url: current.url,
                      at: current.createdAt.toISOString(),
                    }
                  : null;
              }),
            )
          ).filter((r) => r !== null);

          const url = new URL(args.request.url);
          const shippedSha = url.searchParams.get("shipped");
          const shipEnv =
            url.searchParams.get("env") ?? envs[0]?.name ?? "default";
          const shipSkipped = (url.searchParams.get("skipped") ?? "")
            .split(",")
            .filter(Boolean);
          if (shippedSha) {
            // Members are independent — resolve their env + deployment rows concurrently.
            const rows = (
              await Promise.all(
                roster.map(async (member): Promise<ShipStatusRow | null> => {
                  const memberEnvs =
                    member.id === active.id
                      ? envs
                      : await listAgentEnvironments(member.id);
                  const env = memberEnvs.find((e) => e.name === shipEnv);
                  if (!env) return null;
                  // Newest-first list; the first row at the shipped commit is the ship's
                  // deploy (or its retry). Members untouched by the ship have no such row.
                  const match = (await listDeployments(env.id)).find(
                    (d) => d.gitSha === shippedSha,
                  );
                  if (!match) return null;
                  return {
                    agentName: member.name,
                    version: match.version,
                    status: match.status,
                    url: match.url,
                    errorDetail: match.errorDetail,
                    environmentId: env.id,
                    releaseId: match.releaseId,
                  };
                }),
              )
            ).filter((r): r is ShipStatusRow => r !== null);
            if (rows.length > 0)
              ship = { env: shipEnv, rows, skipped: shipSkipped };
          }
        }

        return {
          project,
          roster: roster.map((a) => ({ name: a.name })),
          active: { name: active.name, root: active.root },
          isTeam,
          teamLayout,
          view,
          members,
          teamIntroDismissed,
          config,
          error: null,
          draftPaths: drafts.map((d) => d.path),
          envNames,
          running,
          ship,
        };
      } catch (error) {
        return {
          project,
          roster: [],
          active: null,
          isTeam: false,
          teamLayout: false,
          view: "member" as const,
          members: null,
          teamIntroDismissed: false,
          config: null,
          error: (error as Error).message,
          draftPaths: [],
          envNames: [],
          running: [],
          ship: null,
        };
      }
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
  const repo = { owner: project.repoOwner, repo: project.repoName };

  try {
    // ── Ship: the one-click path — staged changes (or branch head) → deployed version ──
    if (intent === "ship" || intent === "ship-head") {
      // No fallback name: environments are user-defined (M5.7), so a missing field is a
      // bug to surface, not something to paper over with a guessed target.
      const envName = String(form.get("env") ?? "").trim();
      if (!envName) return { error: "Pick an environment to ship to." };
      ensureWorkerStarted();
      // Publish/merge/release run synchronously (same as the Deployment publish button);
      // the build + deploy are queued, and the redirect's ?shipped drives the banner.
      const result =
        intent === "ship"
          ? await shipStagedChanges({
              project,
              envName,
              createdBy: auth.user.id,
            })
          : await shipHead({ project, envName, createdBy: auth.user.id });
      const qs = new URLSearchParams();
      qs.set("shipped", result.gitSha);
      qs.set("env", envName);
      if (result.skipped.length > 0) {
        qs.set("skipped", result.skipped.map((s) => s.agentName).join(","));
      }
      throw redirect(
        `${contextPath(project.id, agentFromParams(args.params))}?${qs.toString()}`,
      );
    }

    // ── Retry a failed shipped deploy (same release, same environment) ──
    if (intent === "retry-deploy") {
      ensureWorkerStarted();
      await queueDeploy({
        environmentId: String(form.get("environmentId")),
        releaseId: String(form.get("releaseId")),
        createdBy: auth.user.id,
      });
      return { ok: true as const };
    }

    // (Model and member removal moved to the Settings tab, M5.8.)

    // ── Add a team member: scaffold agents/<name>/ as a change-set ──
    if (intent === "add-member") {
      const name = slugifyResourceName(String(form.get("name") ?? ""));
      if (!name) return { error: "Member name is required." };
      const { roster } = await resolveAgentContext(project.id, null);
      if (roster.some((a) => a.name === name)) {
        return { error: `A member named "${name}" already exists.` };
      }
      const change = await proposeChange(project.repoInstallationId, repo, {
        base: project.defaultBranch,
        branch: `eden/add-member-${name}`,
        files: memberScaffold(name),
        title: `Add team member: ${name}`,
        body:
          `Scaffolds a new eve agent at \`agents/${name}/\` (instructions, agent.ts, a ` +
          `default sandbox, an example tool, package.json). Eden picks the member up on merge.`,
      });
      return {
        ok: true as const,
        changeUrl: change.pullRequestUrl,
        member: name,
      };
    }

    return { error: "Unknown action." };
  } catch (error) {
    if (error instanceof Response) throw error;
    return { error: (error as Error).message };
  }
}

export function meta() {
  return [{ title: "Project · Eden" }];
}

export default function ProjectDetail({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const {
    project,
    roster,
    active,
    isTeam,
    teamLayout,
    view,
    members,
    teamIntroDismissed,
    config,
    error,
    draftPaths,
    envNames,
    running,
    ship,
  } = loaderData;
  const base = `/repos/${project.id}`;
  // The page's hierarchy level decides its tab set and where its links point (M5.8).
  const level = view === "team" ? "repo" : teamLayout ? "member" : "single";
  const ctx = contextPath(project.id, level === "member" ? active?.name : null);

  // While a shipped deploy is queued/building, poll so the banner walks to live/failed
  // without a manual refresh (same cadence as the Versions page).
  const revalidator = useRevalidator();
  const shipInFlight = !!ship?.rows.some((r) =>
    ["queued", "pending", "building"].includes(r.status),
  );
  useEffect(() => {
    if (!shipInFlight) return;
    const timer = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 3000);
    return () => clearInterval(timer);
  }, [shipInFlight, revalidator]);

  const repoLine =
    project.repoOwner && project.repoName ? (
      <span className="font-mono">
        {project.repoOwner}/{project.repoName} · {project.defaultBranch}
      </span>
    ) : (
      "no repo connected"
    );

  return (
    <AppShell
      breadcrumbs={repoCrumbs({
        projectId: project.id,
        repoName: project.name,
        isTeam: view === "member" && teamLayout,
        agentName: active?.name,
      })}
    >
      <AgentNav
        base={ctx}
        level={level}
        roster={roster}
        activeAgent={level === "member" ? active?.name : undefined}
      />
      {view === "team" ? (
        <PageHeader
          title={
            <span className="flex items-center gap-3">
              {project.name}
              <Badge>
                Team · {roster.length} member{roster.length === 1 ? "" : "s"}
              </Badge>
            </span>
          }
          description={repoLine}
          actions={<AddMemberDialog />}
        />
      ) : (
        <PageHeader
          title={teamLayout && active ? active.name : project.name}
          description={
            teamLayout ? (
              <span>
                Member of{" "}
                <Link
                  to={base}
                  className="font-medium underline underline-offset-4"
                >
                  {project.name}
                </Link>{" "}
                · {repoLine}
              </span>
            ) : (
              repoLine
            )
          }
          actions={
            !error && (
              <ShipDialog
                draftCount={draftPaths.length}
                envNames={envNames}
                defaultBranch={project.defaultBranch}
                agentName={teamLayout && active ? active.name : ""}
              />
            )
          }
        />
      )}
      {view === "member" && running.length > 0 && (
        <p className="-mt-4 mb-6 text-sm text-muted-foreground">
          {running.length === 1 ? (
            <>
              Running{" "}
              <span className="font-semibold text-foreground">
                {running[0].version}
              </span>{" "}
              on {running[0].envName}
              {" · "}updated {timeAgo(running[0].at)}
              {running[0].url && (
                <>
                  {" · "}
                  <a
                    href={running[0].url}
                    className="underline underline-offset-4"
                  >
                    open
                  </a>
                </>
              )}
            </>
          ) : (
            <>
              Running —{" "}
              {running.map((r, i) => (
                <span key={r.envName}>
                  {i > 0 && " · "}
                  {r.envName}:{" "}
                  <span className="font-semibold text-foreground">
                    {r.version}
                  </span>
                </span>
              ))}
            </>
          )}
          {" · "}
          <Link
            to={`${ctx}/deployment`}
            className="underline underline-offset-4"
          >
            View deployment →
          </Link>
        </p>
      )}

      {error && (
        <Alert className="mb-6">
          <AlertTitle>Couldn&rsquo;t read the repo</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
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

      {ship && <ShipProgress ship={ship} dismissTo={ctx} />}

      {actionData?.ok && "changeUrl" in actionData && (
        <Alert className="mb-6">
          <AlertTitle>Change request opened</AlertTitle>
          <AlertDescription>
            The roster updates when the change merges.{" "}
            <Link
              to={`${ctx}/deployment`}
              className="font-medium underline underline-offset-4"
            >
              Review it on the Deployment tab →
            </Link>
          </AlertDescription>
        </Alert>
      )}

      {view === "member" && draftPaths.length > 0 && (
        <Alert className="mb-6">
          <AlertTitle>
            {draftPaths.length} staged change
            {draftPaths.length === 1 ? "" : "s"} not shipped yet
          </AlertTitle>
          <AlertDescription>
            Ship them with the button above, or{" "}
            <Link
              to={`${ctx}/deployment`}
              className="font-medium underline underline-offset-4"
            >
              review &amp; publish on the Deployment tab →
            </Link>
          </AlertDescription>
        </Alert>
      )}

      {view === "team" && members && (
        <TeamSurface
          base={base}
          members={members}
          introDismissed={teamIntroDismissed}
        />
      )}

      {view === "member" && config && active && (
        <AgentSurface
          config={config}
          ctx={ctx}
          root={active.root}
          draftPaths={draftPaths}
        />
      )}
    </AppShell>
  );
}

/**
 * The team landing view (PRD §7.9): the roster is the product surface. Each member is a
 * complete agent — own runtime, channels, schedules, credentials, releases — and this page
 * makes that hierarchy explicit before you drill into one member's config.
 */
function TeamSurface({
  base,
  members,
  introDismissed,
}: {
  base: string;
  members: MemberSummary[];
  introDismissed: boolean;
}) {
  const [showIntro, setShowIntro] = useState(!introDismissed);
  const dismissIntro = () => {
    document.cookie = `${TEAM_INTRO_COOKIE}=1; path=/; max-age=31536000; SameSite=Lax`;
    setShowIntro(false);
  };

  return (
    <div className="space-y-6">
      {showIntro && (
        <Card className="relative border-primary/20 bg-muted/30">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Dismiss"
            className="absolute right-2 top-2 h-7 w-7 text-muted-foreground"
            onClick={dismissIntro}
          >
            <X className="h-4 w-4" />
          </Button>
          <CardContent className="pt-6 pr-10 text-sm text-muted-foreground">
            <p>
              This is a{" "}
              <span className="font-medium text-foreground">team</span>: each
              member below is a complete agent with its own runtime, channels,
              schedules, secrets, and deployments. Members are versioned and
              deployed independently, and changes to several members ship
              atomically in one change request.
            </p>
            <p className="mt-2">
              Coming next: teammates get auto-wired <em>delegation channels</em>{" "}
              — each member receives tools to hand work to the others, so the
              team behaves like an organisation, not a folder of agents.
            </p>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {members.map((m) => (
          <Link
            key={m.name}
            to={`${base}/agents/${encodeURIComponent(m.name)}`}
            prefetch="intent"
            className="group"
          >
            <Card className="h-full transition-colors group-hover:border-ring/60">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="truncate font-mono text-base">
                    {m.name}
                  </CardTitle>
                  <Badge
                    variant="secondary"
                    className="shrink-0 font-mono text-xs"
                  >
                    {m.model ?? "no model"}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                  <li>
                    {m.tools} tool{m.tools === 1 ? "" : "s"}
                  </li>
                  <li>
                    {m.skills} skill{m.skills === 1 ? "" : "s"}
                  </li>
                  <li>
                    {m.schedules} schedule{m.schedules === 1 ? "" : "s"}
                  </li>
                  <li>
                    {m.channels} channel{m.channels === 1 ? "" : "s"}
                  </li>
                </ul>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}

/** "Add member" → a change-set scaffolding agents/<name>/ (git-native roster CRUD). */
function AddMemberDialog() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const slug = slugifyResourceName(name);
  const submit = useSubmit();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  const create = () => {
    if (!slug) return;
    setOpen(false);
    setName("");
    submit({ intent: "add-member", name: slug }, { method: "post" });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" disabled={busy}>
          Add member
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a team member</DialogTitle>
          <DialogDescription>
            Scaffolds a complete eve agent and opens a change request — the
            member joins the roster when it merges.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="new-member-name">Member name</Label>
          <Input
            id="new-member-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                create();
              }
            }}
            placeholder="product-manager"
            autoFocus
          />
          <p className="text-xs text-muted-foreground">
            {slug ? (
              <>
                Creates <span className="font-mono">agents/{slug}/</span>
              </>
            ) : (
              "Names become kebab-case directory names."
            )}
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={create} disabled={!slug || busy}>
            Open change request
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Ship — the one-click deploy. One dialog confirms the target environment (the member's
 * primary — its first — preselected), then a single action publishes + merges the staged
 * changes (or reuses the branch head), cuts the version, and queues the deploy. The current
 * version keeps serving until the new one is healthy, so shipping is never a step backwards.
 */
function ShipDialog({
  draftCount,
  envNames,
  defaultBranch,
  agentName,
}: {
  draftCount: number;
  envNames: string[];
  defaultBranch: string;
  agentName: string;
}) {
  const [open, setOpen] = useState(false);
  const [env, setEnv] = useState(envNames[0] ?? "default");
  const navigation = useNavigation();
  const shipping =
    navigation.state !== "idle" &&
    ["ship", "ship-head"].includes(
      String(navigation.formData?.get("intent") ?? ""),
    );
  // Publish + merge run synchronously, so hold the dialog open with a progress label until
  // the submission settles — the redirect's banner (success) or page alert (error) takes over.
  const wasShipping = useRef(false);
  useEffect(() => {
    if (shipping) {
      wasShipping.current = true;
      return;
    }
    if (wasShipping.current) {
      wasShipping.current = false;
      setOpen(false);
    }
  }, [shipping]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button disabled={navigation.state !== "idle"}>
          {draftCount > 0
            ? `Ship ${draftCount} change${draftCount === 1 ? "" : "s"}`
            : `Ship latest from ${defaultBranch}`}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {draftCount > 0
              ? `Ship ${draftCount} staged change${draftCount === 1 ? "" : "s"}?`
              : `Ship the latest ${defaultBranch}?`}
          </DialogTitle>
          <DialogDescription>
            {draftCount > 0
              ? "Publishes and merges your staged changes, cuts a new version, and deploys it. The current version keeps serving until the new one is healthy."
              : `Cuts a version from the newest commit on ${defaultBranch} and deploys it. A commit that already shipped is reused — no rebuild.`}
          </DialogDescription>
        </DialogHeader>
        <Form method="post">
          <input
            type="hidden"
            name="intent"
            value={draftCount > 0 ? "ship" : "ship-head"}
          />
          <input type="hidden" name="agent" value={agentName} />
          <div className="space-y-1.5">
            <Label htmlFor="ship-env">Environment</Label>
            <Select name="env" value={env} onValueChange={setEnv}>
              <SelectTrigger id="ship-env" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {envNames.map((n) => (
                  <SelectItem key={n} value={n}>
                    {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter className="mt-4">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={shipping}>
              {shipping ? "Shipping…" : `Ship to ${env}`}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Deploy progress for a shipped commit. Driven purely from deployment rows (via ?shipped=),
 * so it survives refreshes and walks queued → building → live/failed with the poller.
 */
function ShipProgress({
  ship,
  dismissTo,
}: {
  ship: { env: string; rows: ShipStatusRow[]; skipped: string[] };
  dismissTo: string;
}) {
  const retry = useFetcher();
  const failed = ship.rows.filter((r) => r.status === "failed");
  const allLive = ship.rows.every((r) => r.status === "live");
  const version = ship.rows[0]?.version ?? "";
  const single = ship.rows.length === 1;

  return (
    <Alert
      variant={failed.length > 0 ? "destructive" : "default"}
      className="mb-6"
    >
      <AlertTitle>
        {allLive
          ? `${version} is running on ${ship.env}`
          : failed.length > 0
            ? `${version} couldn't deploy to ${ship.env} — the previous version is still running`
            : `Shipping ${version} to ${ship.env}…`}
      </AlertTitle>
      <AlertDescription>
        <div className="mt-1 space-y-2">
          {ship.rows.map((r) => (
            <div
              key={r.environmentId}
              className="flex flex-wrap items-center gap-x-2 gap-y-1"
            >
              {!single && <span className="font-medium">{r.agentName}:</span>}
              <ShipSteps status={r.status} version={r.version} />
              {r.status === "live" && r.url && (
                <a href={r.url} className="underline underline-offset-4">
                  open
                </a>
              )}
              {r.status === "failed" && (
                <retry.Form method="post">
                  <input type="hidden" name="intent" value="retry-deploy" />
                  <input
                    type="hidden"
                    name="environmentId"
                    value={r.environmentId}
                  />
                  <input type="hidden" name="releaseId" value={r.releaseId} />
                  <Button
                    type="submit"
                    size="sm"
                    variant="outline"
                    disabled={retry.state !== "idle"}
                  >
                    {retry.state !== "idle" ? "Retrying…" : "Retry"}
                  </Button>
                </retry.Form>
              )}
            </div>
          ))}
          {ship.skipped.length > 0 && (
            <p className="text-xs">
              Not deployed for {ship.skipped.join(", ")} — no environment named{" "}
              <span className="font-mono">{ship.env}</span>.
            </p>
          )}
          {failed.map(
            (r) =>
              r.errorDetail && (
                <p
                  key={`err-${r.environmentId}`}
                  className="whitespace-pre-wrap font-mono text-xs"
                >
                  {r.errorDetail}
                </p>
              ),
          )}
          {(allLive || failed.length > 0) && (
            <p>
              <Link
                to={dismissTo}
                className="text-xs underline underline-offset-4"
              >
                Dismiss
              </Link>
            </p>
          )}
        </div>
      </AlertDescription>
    </Alert>
  );
}

/** The pipeline as PM-readable steps: the sync stages are done by construction. */
function ShipSteps({ status, version }: { status: string; version: string }) {
  const stage =
    status === "live"
      ? "Running ✓"
      : status === "failed"
        ? "Failed ✗"
        : status === "building"
          ? "Building…"
          : status === "stopped" || status === "draining"
            ? "Superseded"
            : "Queued…";
  return (
    <span className="text-sm">
      Published ✓ <span className="text-muted-foreground">→</span> {version}{" "}
      created ✓ <span className="text-muted-foreground">→</span> {stage}
    </span>
  );
}

/** One-line hint per category, so the config surface teaches the eve model as you scan it. */
const CATEGORY_HINTS: Record<string, string> = {
  tools: "TypeScript functions the agent can call",
  skills: "On-demand Markdown playbooks",
  subagents: "Specialist child agents this one delegates to",
  channels: "Entry points — HTTP, Slack, web chat",
  schedules: "Recurring cron-triggered runs",
  connections: "Typed external integrations",
};

/** How many items a category card previews before deferring to its list page. */
const CARD_PREVIEW_COUNT = 5;

function AgentSurface({
  config,
  ctx,
  root,
  draftPaths,
}: {
  config: AgentConfig;
  /** The member's base path (repo base for single-agent repos) — editor links hang off it. */
  ctx: string;
  /** Active member's agent directory ("agent" or "agents/<member>/agent"). */
  root: string;
  draftPaths: string[];
}) {
  const drafted = new Set(draftPaths);

  // Stable elements between renders (JSX props otherwise defeat memoized children).
  const instructionsStaged = drafted.has(`${root}/instructions.md`);
  const instructionsBadges = useMemo(
    () =>
      instructionsStaged ? (
        <Badge variant="outline" className="text-xs">
          staged
        </Badge>
      ) : null,
    [instructionsStaged],
  );

  // Sandbox is a singleton like instructions: the repo file wins; a staged NEW sandbox.ts
  // (draft not yet in the repo) still counts as a custom definition in progress.
  const sandboxFile = config.sandbox?.path ?? sandboxPath(root);
  const sandboxStaged = drafted.has(sandboxFile);
  const hasCustomSandbox = config.sandbox !== null || sandboxStaged;
  const sandboxBadges = useMemo(
    () =>
      sandboxStaged ? (
        <Badge variant="outline" className="text-xs">
          staged
        </Badge>
      ) : null,
    [sandboxStaged],
  );

  return (
    <div className="space-y-8">
      {/* Model moved to the Settings tab (M5.8). */}
      {/* Instructions — the always-on system prompt. */}
      <section>
        <SectionHeader
          title="Instructions"
          badges={instructionsBadges}
          actions={
            <Button variant="outline" size="sm" asChild>
              <Link to={`${ctx}/edit/instructions`}>
                {config.instructions ? "Edit" : "Add instructions"}
              </Link>
            </Button>
          }
        />
        {config.instructions ? (
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-lg border bg-muted/40 p-4 text-sm">
            {config.instructions}
          </pre>
        ) : (
          <p className="text-sm text-muted-foreground">
            No instructions.md yet — this Markdown becomes the agent&rsquo;s
            always-on system prompt.
          </p>
        )}
      </section>

      {/* Resources — at-a-glance cards; each category's list page is the management surface. */}
      <section>
        <SectionHeader title="Resources" />
        <div className="grid gap-4 sm:grid-cols-2">
          {AGENT_CATEGORIES.map((cat) => {
            const repoItems = config[cat.key];
            // Staged NEW files (drafts not yet in the repo) still belong in their category.
            const stagedNew = draftPaths.flatMap((p) =>
              p.startsWith(`${root}/${cat.dir}/`) &&
              !repoItems.some((i) => i.path === p)
                ? [{ path: p, name: p.split("/").pop()!, isDirectory: false }]
                : [],
            );
            const items = [...repoItems, ...stagedNew];
            const listTo = `${ctx}/resources/${cat.key}`;
            return (
              <Card key={cat.key}>
                <CardHeader className="space-y-1 pb-3">
                  <div className="flex items-center justify-between">
                    <Link to={listTo} className="group flex items-center gap-2">
                      <CardTitle className="text-base underline-offset-4 group-hover:underline">
                        {cat.label}
                      </CardTitle>
                      <Badge variant="secondary">{items.length}</Badge>
                    </Link>
                    <NewResourceDialog
                      kind={RESOURCE_KINDS[cat.key]}
                      base={ctx}
                      root={root}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {CATEGORY_HINTS[cat.key]}
                  </p>
                </CardHeader>
                <CardContent className="pt-0">
                  {items.length === 0 ? (
                    <p className="text-sm text-muted-foreground">None</p>
                  ) : (
                    <ul className="space-y-1 text-sm">
                      {items.slice(0, CARD_PREVIEW_COUNT).map((item) => (
                        <li key={item.path} className="flex items-center gap-2">
                          {item.isDirectory ? (
                            <span className="font-mono text-muted-foreground">
                              {item.name}/
                            </span>
                          ) : (
                            <Link
                              to={`${ctx}/edit?path=${encodeURIComponent(item.path)}`}
                              className="font-mono underline-offset-4 hover:underline"
                            >
                              {item.name}
                            </Link>
                          )}
                          {drafted.has(item.path) && (
                            <Badge variant="outline" className="text-xs">
                              staged
                            </Badge>
                          )}
                        </li>
                      ))}
                      {items.length > CARD_PREVIEW_COUNT && (
                        <li className="text-xs text-muted-foreground">
                          +{items.length - CARD_PREVIEW_COUNT} more
                        </li>
                      )}
                    </ul>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      </section>

      {/* Sandbox — the isolated shell the agent's bash/file tools run in (one per agent). */}
      <section>
        <SectionHeader
          title="Sandbox"
          badges={sandboxBadges}
          actions={
            <Button variant="outline" size="sm" asChild>
              <Link to={`${ctx}/edit?path=${encodeURIComponent(sandboxFile)}`}>
                {hasCustomSandbox ? "Edit" : "Customize"}
              </Link>
            </Button>
          }
        />
        {hasCustomSandbox ? (
          <p className="text-sm text-muted-foreground">
            Custom definition at{" "}
            <span className="font-mono text-foreground">{sandboxFile}</span>
            {config.sandbox?.hasWorkspace && (
              <>
                {" "}
                · seeds files from{" "}
                <span className="font-mono">sandbox/workspace/</span>
              </>
            )}
            . Its bootstrap runs once and is snapshotted into a reusable
            template every session starts from.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            Framework default — an isolated shell for the agent&rsquo;s bash
            and file tools. Customize it to preinstall CLIs at bootstrap or to
            forward secrets marked for the sandbox (Settings → Secrets).
          </p>
        )}
      </section>
    </div>
  );
}
