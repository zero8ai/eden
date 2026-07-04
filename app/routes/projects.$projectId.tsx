/**
 * Project overview — the repo-backed config surface for the ACTIVE roster member (PRD §7.9).
 *
 * Single-agent repos are teams of one: no switcher, the surface reads from `agent/` exactly
 * as before the split. Team repos get a member switcher (AgentNav), per-member surfaces
 * rooted at `agents/<member>/agent/`, and roster CRUD — add/remove members land as
 * change-sets (branch → PR) like every other edit; the roster row itself syncs on merge.
 */
import { authkitLoader, withAuth } from "@workos-inc/authkit-react-router";
import { useState } from "react";
import {
  Form,
  Link,
  data,
  redirect,
  useFetcher,
  useNavigation,
  useSubmit,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { ConfirmDialog } from "~/components/confirm-dialog";
import { ModelSelect } from "~/components/model-select";
import { NewResourceDialog } from "~/components/new-resource-dialog";
import { AgentNav, AppShell, PageHeader, SectionHeader, repoCrumbs } from "~/components/shell";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
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
import { syncProjectAgents, withPreservedNames, type Agent } from "~/db/queries.server";
import { listDrafts, resolveFileView, stageDraft } from "~/drafts/drafts.server";
import { readModel, scaffoldAgentModule, setModel } from "~/eve/agentModule";
import { buildAgentConfig, detectAgentRoots } from "~/eve/parse";
import { RESOURCE_KINDS, slugifyResourceName } from "~/eve/templates";
import { AGENT_CATEGORIES, type AgentConfig } from "~/eve/types";
import { memberScaffold } from "~/github/create.server";
import { fetchAgentSource } from "~/github/repo.server";
import { proposeChange, type FileChange } from "~/github/write.server";
import {
  agentParam,
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
  /** Member view: the active member's parsed config. */
  config: AgentConfig | null;
  error: string | null;
  /** Paths with staged (unpublished) drafts, so the config surface can flag them. */
  draftPaths: string[];
}

export const loader = (args: LoaderFunctionArgs) =>
  authkitLoader(
    args,
    async ({ auth }): Promise<ProjectView> => {
      const project = await requireProject(
        { user: auth.user, organizationId: auth.organizationId, role: auth.role },
        args.params.projectId,
      );

      if (!project.repoInstallationId || !project.repoOwner || !project.repoName) {
        return {
          project,
          roster: [],
          active: null,
          isTeam: false,
          teamLayout: false,
          view: "member" as const,
          members: null,
          config: null,
          error: "This project has no connected repo.",
          draftPaths: [],
        };
      }

      try {
        const [source, drafts] = await Promise.all([
          fetchAgentSource(project.repoInstallationId, {
            owner: project.repoOwner,
            repo: project.repoName,
          }),
          listDrafts(project.id),
        ]);

        // Self-heal the roster from the repo (external pushes don't always hit our webhook).
        const requestedAgent = agentParam(args.request);
        let { roster, active, isTeam } = await resolveAgentContext(
          project.id,
          requestedAgent,
        );
        const detected = withPreservedNames(roster, detectAgentRoots(source.paths));
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
        const view = teamLayout && !requestedAgent ? ("team" as const) : ("member" as const);
        const members =
          view === "team"
            ? roster.map((a) => {
                const c = buildAgentConfig(source, a.root);
                return {
                  name: a.name,
                  model: c.model,
                  tools: c.tools.length,
                  skills: c.skills.length,
                  schedules: c.schedules.length,
                  channels: c.channels.length,
                };
              })
            : null;

        // The model shown inline must reflect the newest intent: a staged agent.ts draft
        // wins over the repo value (same rule the editors follow).
        const config = view === "member" ? buildAgentConfig(source, active.root) : null;
        const agentTsDraft = drafts.find((d) => d.path === `${active.root}/agent.ts`);
        if (config && agentTsDraft) {
          config.model = readModel(agentTsDraft.content) ?? config.model;
          config.hasAgentModule = true;
        }

        return {
          project,
          roster: roster.map((a) => ({ name: a.name })),
          active: { name: active.name, root: active.root },
          isTeam,
          teamLayout,
          view,
          members,
          config,
          error: null,
          draftPaths: drafts.map((d) => d.path),
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
          config: null,
          error: (error as Error).message,
          draftPaths: [],
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
    // ── Inline model change (the overview's one settings control): stage agent.ts ──
    if (intent === "set-model") {
      const model = String(form.get("model") ?? "").trim();
      if (!model) return { error: "Pick or enter a model." };
      const { active } = await resolveAgentContext(
        project.id,
        String(form.get("agent") ?? "") || null,
      );
      const path = `${active.root}/agent.ts`;
      // Base the targeted edit on the latest intended value (draft → pending → repo) so
      // setting the model never silently reverts other unmerged edits to this file.
      const view = await resolveFileView(project, path);
      const next = view.content ? setModel(view.content, model) : scaffoldAgentModule(model);
      await stageDraft({
        projectId: project.id,
        path,
        content: next,
        createdBy: auth.user.id,
      });
      return { ok: true as const, staged: path };
    }

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
          `Scaffolds a new eve agent at \`agents/${name}/\` (instructions, agent.ts, an ` +
          `example tool, package.json). Eden picks the member up on merge.`,
      });
      return { ok: true as const, changeUrl: change.pullRequestUrl, member: name };
    }

    // ── Remove a team member: delete agents/<name>/ as a change-set ──
    if (intent === "remove-member") {
      const name = String(form.get("name") ?? "");
      const { roster } = await resolveAgentContext(project.id, null);
      const member = roster.find((a) => a.name === name);
      if (!member || member.root === "agent") {
        return { error: "Only team members (agents/<name>/) can be removed." };
      }
      if (roster.length <= 1) {
        return { error: "A team needs at least one member." };
      }
      const source = await fetchAgentSource(project.repoInstallationId, repo);
      const memberDir = `agents/${name}/`;
      const files: FileChange[] = source.paths
        .filter((p) => p.startsWith(memberDir))
        .map((p) => ({ path: p, content: null }));
      if (files.length === 0) return { error: `No files found under ${memberDir}.` };
      const change = await proposeChange(project.repoInstallationId, repo, {
        base: project.defaultBranch,
        branch: `eden/remove-member-${name}`,
        files,
        title: `Remove team member: ${name}`,
        body:
          `Deletes \`agents/${name}/\` (${files.length} files). Merging removes the member; ` +
          `its releases and run history remain until then.`,
      });
      return { ok: true as const, changeUrl: change.pullRequestUrl, member: name };
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

export default function ProjectDetail({ loaderData, actionData }: Route.ComponentProps) {
  const {
    project,
    roster,
    active,
    isTeam,
    teamLayout,
    view,
    members,
    config,
    error,
    draftPaths,
  } = loaderData;
  const base = `/repos/${project.id}`;
  const agentSuffix =
    view === "member" && teamLayout && active
      ? `?agent=${encodeURIComponent(active.name)}`
      : "";

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
      {view === "team" ? (
        <PageHeader
          title={
            <span className="flex items-center gap-3">
              {project.name}
              <Badge>Team · {roster.length} member{roster.length === 1 ? "" : "s"}</Badge>
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
                <Link to={base} className="font-medium underline underline-offset-4">
                  {project.name}
                </Link>{" "}
                · {repoLine}
              </span>
            ) : (
              repoLine
            )
          }
          actions={
            <div className="flex items-center gap-2">
              {teamLayout && isTeam && active && (
                <RemoveMemberButton member={active.name} />
              )}
              <Button asChild>
                <Link to={`${base}/deployments${agentSuffix}`}>Deploy</Link>
              </Button>
            </div>
          }
        />
      )}
      <AgentNav
        base={base}
        roster={roster}
        activeAgent={view === "member" ? active?.name : undefined}
      />

      {error && (
        <Alert className="mb-6">
          <AlertTitle>Couldn&rsquo;t read the repo</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {actionData?.error && (
        <Alert variant="destructive" className="mb-6">
          <AlertTitle>Couldn&rsquo;t update the team</AlertTitle>
          <AlertDescription>{actionData.error}</AlertDescription>
        </Alert>
      )}

      {actionData?.ok && "changeUrl" in actionData && (
        <Alert className="mb-6">
          <AlertTitle>Change request opened</AlertTitle>
          <AlertDescription>
            The roster updates when the change merges.{" "}
            <Link
              to={`${base}/changes${agentSuffix}`}
              className="font-medium underline underline-offset-4"
            >
              Review it in Changes →
            </Link>
          </AlertDescription>
        </Alert>
      )}

      {draftPaths.length > 0 && (
        <Alert className="mb-6">
          <AlertTitle>
            {draftPaths.length} staged change{draftPaths.length === 1 ? "" : "s"} not
            published yet
          </AlertTitle>
          <AlertDescription>
            <Link
              to={`${base}/changes${agentSuffix}`}
              className="font-medium underline underline-offset-4"
            >
              Review &amp; publish in Changes →
            </Link>
          </AlertDescription>
        </Alert>
      )}

      {view === "team" && members && (
        <TeamSurface base={base} members={members} />
      )}

      {view === "member" && config && active && (
        <AgentSurface
          config={config}
          projectId={project.id}
          agentName={active.name}
          root={active.root}
          agentSuffix={agentSuffix}
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
function TeamSurface({ base, members }: { base: string; members: MemberSummary[] }) {
  return (
    <div className="space-y-6">
      <Card className="border-primary/20 bg-muted/30">
        <CardContent className="pt-6 text-sm text-muted-foreground">
          <p>
            This is a <span className="font-medium text-foreground">team</span>: each member
            below is a complete agent with its own runtime, channels, schedules, secrets, and
            deployments. Members are versioned and deployed independently, and changes to
            several members ship atomically in one change request.
          </p>
          <p className="mt-2">
            Coming next: teammates get auto-wired <em>delegation channels</em> — each member
            receives tools to hand work to the others, so the team behaves like an
            organisation, not a folder of agents.
          </p>
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        {members.map((m) => (
          <Link key={m.name} to={`${base}?agent=${encodeURIComponent(m.name)}`} className="group">
            <Card className="h-full transition-colors group-hover:border-ring/60">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="truncate font-mono text-base">{m.name}</CardTitle>
                  <Badge variant="secondary" className="shrink-0 font-mono text-xs">
                    {m.model ?? "no model"}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                  <li>{m.tools} tool{m.tools === 1 ? "" : "s"}</li>
                  <li>{m.skills} skill{m.skills === 1 ? "" : "s"}</li>
                  <li>{m.schedules} schedule{m.schedules === 1 ? "" : "s"}</li>
                  <li>{m.channels} channel{m.channels === 1 ? "" : "s"}</li>
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
            Scaffolds a complete eve agent and opens a change request — the member joins
            the roster when it merges.
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

/** "Remove member" → a change-set deleting agents/<name>/ (confirmed, git-recoverable). */
function RemoveMemberButton({ member }: { member: string }) {
  const submit = useSubmit();
  const navigation = useNavigation();
  return (
    <ConfirmDialog
      trigger={
        <Button variant="outline" disabled={navigation.state !== "idle"}>
          Remove member
        </Button>
      }
      title={`Remove ${member} from the team?`}
      description={`Opens a change request deleting agents/${member}/. Nothing is removed until it merges, and git can restore it after.`}
      confirmLabel="Open change request"
      onConfirm={() =>
        submit({ intent: "remove-member", name: member }, { method: "post" })
      }
    />
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
  projectId,
  agentName,
  root,
  agentSuffix,
  draftPaths,
}: {
  config: AgentConfig;
  projectId: string;
  agentName: string;
  /** Active member's agent directory ("agent" or "agents/<member>/agent"). */
  root: string;
  /** "" for single-agent repos; "?agent=<name>" for teams (keeps editor links scoped). */
  agentSuffix: string;
  draftPaths: string[];
}) {
  const base = `/repos/${projectId}`;
  const drafted = new Set(draftPaths);
  const modelFetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const savingModel = modelFetcher.state !== "idle";

  return (
    <div className="space-y-8">
      {/* Model — the one runtime setting, edited in place (saving stages agent.ts). */}
      <section>
        <SectionHeader
          title="Model"
          badges={
            <>
              {drafted.has(`${root}/agent.ts`) && (
                <Badge variant="outline" className="text-xs">
                  staged
                </Badge>
              )}
              {!config.hasAgentModule && (
                <Badge variant="outline" className="text-xs">
                  no agent.ts — picking one scaffolds it
                </Badge>
              )}
            </>
          }
        />
        <ModelSelect
          value={config.model}
          busy={savingModel}
          onCommit={(model) =>
            modelFetcher.submit(
              { intent: "set-model", model, agent: agentName },
              { method: "post" },
            )
          }
        />
        {modelFetcher.data?.error && (
          <p className="mt-2 text-sm text-destructive">{modelFetcher.data.error}</p>
        )}
      </section>

      {/* Instructions — the always-on system prompt. */}
      <section>
        <SectionHeader
          title="Instructions"
          badges={
            drafted.has(`${root}/instructions.md`) && (
              <Badge variant="outline" className="text-xs">
                staged
              </Badge>
            )
          }
          actions={
            <Button variant="outline" size="sm" asChild>
              <Link to={`${base}/edit/instructions${agentSuffix}`}>
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
            No instructions.md yet — this Markdown becomes the agent&rsquo;s always-on
            system prompt.
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
            const listTo = `${base}/resources/${cat.key}${agentSuffix}`;
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
                      base={base}
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
                    <>
                      <ul className="space-y-1 text-sm">
                        {items.slice(0, CARD_PREVIEW_COUNT).map((item) => (
                          <li key={item.path} className="flex items-center gap-2">
                            {item.isDirectory ? (
                              <span className="font-mono text-muted-foreground">
                                {item.name}/
                              </span>
                            ) : (
                              <Link
                                to={`${base}/edit?path=${encodeURIComponent(item.path)}`}
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
                      </ul>
                      <Link
                        to={listTo}
                        className="mt-2 inline-block text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                      >
                        View all {items.length} →
                      </Link>
                    </>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      </section>
    </div>
  );
}
