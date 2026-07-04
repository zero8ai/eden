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
  useNavigation,
  useSubmit,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { ConfirmDialog } from "~/components/confirm-dialog";
import { NewResourceDialog } from "~/components/new-resource-dialog";
import { AgentNav, AppShell, PageHeader } from "~/components/shell";
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
import { syncProjectAgents, type Agent } from "~/db/queries.server";
import { listDrafts } from "~/drafts/drafts.server";
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

interface ProjectView {
  project: Project;
  roster: { name: string }[];
  active: Pick<Agent, "name" | "root"> | null;
  isTeam: boolean;
  /** True when the repo uses the team layout (agents/*) — enables roster CRUD. */
  teamLayout: boolean;
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
        const detected = detectAgentRoots(source.paths);
        let { roster, active, isTeam } = await resolveAgentContext(
          project.id,
          agentParam(args.request),
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
            agentParam(args.request),
          ));
        }

        return {
          project,
          roster: roster.map((a) => ({ name: a.name })),
          active: { name: active.name, root: active.root },
          isTeam,
          teamLayout: active.root !== "agent",
          config: buildAgentConfig(source, active.root),
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
  const { project, roster, active, isTeam, teamLayout, config, error, draftPaths } =
    loaderData;
  const base = `/projects/${project.id}`;
  const agentSuffix =
    isTeam && active ? `?agent=${encodeURIComponent(active.name)}` : "";

  return (
    <AppShell>
      <PageHeader
        title={project.name}
        description={
          project.repoOwner && project.repoName ? (
            <span className="font-mono">
              {project.repoOwner}/{project.repoName} · {project.defaultBranch}
              {isTeam && active && (
                <>
                  {" · "}
                  <span className="text-foreground">{active.name}</span>
                </>
              )}
            </span>
          ) : (
            "no repo connected"
          )
        }
        actions={
          <div className="flex items-center gap-2">
            {teamLayout && <AddMemberDialog />}
            {teamLayout && isTeam && active && (
              <RemoveMemberButton member={active.name} />
            )}
            <Button asChild>
              <Link to={`${base}/deployments${agentSuffix}`}>Deploy</Link>
            </Button>
          </div>
        }
      />
      <AgentNav base={base} roster={roster} activeAgent={active?.name} />

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

      {actionData?.ok && (
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

      {config && active && (
        <AgentSurface
          config={config}
          projectId={project.id}
          root={active.root}
          agentSuffix={agentSuffix}
          draftPaths={draftPaths}
        />
      )}
    </AppShell>
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

function AgentSurface({
  config,
  projectId,
  root,
  agentSuffix,
  draftPaths,
}: {
  config: AgentConfig;
  projectId: string;
  /** Active member's agent directory ("agent" or "agents/<member>/agent"). */
  root: string;
  /** "" for single-agent repos; "?agent=<name>" for teams (keeps editor links scoped). */
  agentSuffix: string;
  draftPaths: string[];
}) {
  const base = `/projects/${projectId}`;
  const drafted = new Set(draftPaths);
  return (
    <div className="space-y-6">
      {/* The active member: model + instructions. */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div className="flex items-center gap-3">
            <CardTitle>Agent</CardTitle>
            <Badge variant={config.hasAgentModule ? "secondary" : "outline"}>
              {config.hasAgentModule ? "agent.ts" : "no agent.ts"}
            </Badge>
            {drafted.has(`${root}/agent.ts`) && (
              <Badge variant="outline" className="text-xs">
                staged
              </Badge>
            )}
          </div>
          <Button variant="outline" size="sm" asChild>
            <Link to={`${base}/edit/agent${agentSuffix}`}>Edit config</Link>
          </Button>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Model</span>
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono">
              {config.model ?? "—"}
            </code>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div className="flex items-center gap-3">
            <CardTitle>Instructions</CardTitle>
            {drafted.has(`${root}/instructions.md`) && (
              <Badge variant="outline" className="text-xs">
                staged
              </Badge>
            )}
          </div>
          <Button variant="outline" size="sm" asChild>
            <Link to={`${base}/edit/instructions${agentSuffix}`}>Edit</Link>
          </Button>
        </CardHeader>
        <CardContent>
          {config.instructions ? (
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-lg border bg-muted/40 p-4 text-sm">
              {config.instructions}
            </pre>
          ) : (
            <p className="text-sm text-muted-foreground">
              No instructions.md found.
            </p>
          )}
        </CardContent>
      </Card>

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
          return (
            <Card key={cat.key}>
              <CardHeader className="space-y-1 pb-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <CardTitle className="text-base">{cat.label}</CardTitle>
                    <Badge variant="secondary">{items.length}</Badge>
                  </div>
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
                  <ul className="space-y-1 text-sm">
                    {items.map((item) => (
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
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
