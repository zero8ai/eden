/**
 * Read-only visualization of a connected eve agent's config surface (M0, Step 4).
 *
 * Proves the parse layer before M1 adds editors. Reads the repo through the GitHub App and
 * renders the normalized AgentConfig — model, instructions, and each eve concept category.
 */
import { authkitLoader } from "@workos-inc/authkit-react-router";
import { Link, data, type LoaderFunctionArgs } from "react-router";

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
import { syncTenant } from "~/auth/tenant.server";
import { getProject } from "~/db/queries.server";
import { listDrafts } from "~/drafts/drafts.server";
import { AGENT_ROOT, buildAgentConfig, detectAgentRoots } from "~/eve/parse";
import { RESOURCE_KINDS } from "~/eve/templates";
import { AGENT_CATEGORIES, type AgentConfig } from "~/eve/types";
import { fetchAgentSource } from "~/github/repo.server";
import type { Project } from "~/db/queries.server";
import type { Route } from "./+types/projects.$projectId";

/** One team member and its parsed config (team repos, PRD §7.9). */
interface TeamMemberView {
  name: string;
  root: string;
  config: AgentConfig;
}

interface ProjectView {
  project: Project;
  /** Single-agent repos: the parsed config. Null for team repos (see `members`). */
  config: AgentConfig | null;
  /** Team repos: the roster, one entry per `agents/<member>/agent/`. Null for single. */
  members: TeamMemberView[] | null;
  error: string | null;
  /** Paths with staged (unpublished) drafts, so the config surface can flag them. */
  draftPaths: string[];
}

export const loader = (args: LoaderFunctionArgs) =>
  authkitLoader(
    args,
    async ({ auth }): Promise<ProjectView> => {
      const { org } = await syncTenant({
        user: auth.user,
        organizationId: auth.organizationId,
        role: auth.role,
      });
      if (!org) throw data("No organization", { status: 403 });

      const project = await getProject(org.id, args.params.projectId!);
      if (!project) throw data("Project not found", { status: 404 });

      if (!project.repoInstallationId || !project.repoOwner || !project.repoName) {
        return {
          project,
          config: null,
          members: null,
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
        const roots = detectAgentRoots(source.paths);
        const isTeam = roots.length > 0 && roots[0].root !== AGENT_ROOT;
        return {
          project,
          config: isTeam ? null : buildAgentConfig(source),
          members: isTeam
            ? roots.map((r) => ({ ...r, config: buildAgentConfig(source, r.root) }))
            : null,
          error: null,
          draftPaths: drafts.map((d) => d.path),
        };
      } catch (error) {
        return {
          project,
          config: null,
          members: null,
          error: (error as Error).message,
          draftPaths: [],
        };
      }
    },
    { ensureSignedIn: true },
  );

export function meta() {
  return [{ title: "Project · Eden" }];
}

export default function ProjectDetail({ loaderData }: Route.ComponentProps) {
  const { project, config, members, error, draftPaths } = loaderData;
  const base = `/projects/${project.id}`;

  return (
    <AppShell>
      <PageHeader
        title={project.name}
        description={
          project.repoOwner && project.repoName ? (
            <span className="font-mono">
              {project.repoOwner}/{project.repoName} · {project.defaultBranch}
            </span>
          ) : (
            "no repo connected"
          )
        }
        actions={
          <Button asChild>
            <Link to={`${base}/deployments`}>Deploy</Link>
          </Button>
        }
      />
      <AgentNav base={base} />

      {error && (
        <Alert className="mb-6">
          <AlertTitle>Couldn&rsquo;t read the repo</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
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
              to={`${base}/changes`}
              className="font-medium underline underline-offset-4"
            >
              Review &amp; publish in Changes →
            </Link>
          </AlertDescription>
        </Alert>
      )}

      {config && (
        <AgentSurface
          config={config}
          projectId={project.id}
          draftPaths={draftPaths}
        />
      )}

      {members && <TeamSurface members={members} />}
    </AppShell>
  );
}

/**
 * Read-only roster for a team repo (`agents/<member>/agent/`, PRD §7.9). Per-member editing
 * arrives with the projects → agents schema split (Milestone 5.5); until then the roster is
 * visible but edited via the repo/assistant.
 */
function TeamSurface({ members }: { members: TeamMemberView[] }) {
  return (
    <div className="space-y-6">
      <Alert>
        <AlertTitle>This is a team repository</AlertTitle>
        <AlertDescription>
          {members.length} member{members.length === 1 ? "" : "s"} under{" "}
          <span className="font-mono">agents/</span>. In-app editors for individual team
          members are coming with the agents split — for now, edit members through the
          assistant or directly in the repo.
        </AlertDescription>
      </Alert>
      <div className="grid gap-4 sm:grid-cols-2">
        {members.map((m) => (
          <Card key={m.root}>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle className="font-mono text-base">{m.name}</CardTitle>
              <Badge variant={m.config.hasAgentModule ? "secondary" : "outline"}>
                {m.config.hasAgentModule ? "agent.ts" : "no agent.ts"}
              </Badge>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">Model</span>
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono">
                  {m.config.model ?? "—"}
                </code>
              </div>
              <ul className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                {AGENT_CATEGORIES.map((cat) => (
                  <li key={cat.key} className="flex items-center justify-between">
                    <span className="text-muted-foreground">{cat.label}</span>
                    <span>{m.config[cat.key].length}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
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
  draftPaths,
}: {
  config: AgentConfig;
  projectId: string;
  draftPaths: string[];
}) {
  const base = `/projects/${projectId}`;
  const drafted = new Set(draftPaths);
  return (
    <div className="space-y-6">
      {/* The root agent: model + instructions. One repo == one root agent. */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div className="flex items-center gap-3">
            <CardTitle>Agent</CardTitle>
            <Badge variant={config.hasAgentModule ? "secondary" : "outline"}>
              {config.hasAgentModule ? "agent.ts" : "no agent.ts"}
            </Badge>
            {drafted.has("agent/agent.ts") && (
              <Badge variant="outline" className="text-xs">
                staged
              </Badge>
            )}
          </div>
          <Button variant="outline" size="sm" asChild>
            <Link to={`${base}/edit/agent`}>Edit config</Link>
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
            {drafted.has("agent/instructions.md") && (
              <Badge variant="outline" className="text-xs">
                staged
              </Badge>
            )}
          </div>
          <Button variant="outline" size="sm" asChild>
            <Link to={`${base}/edit/instructions`}>Edit</Link>
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
            p.startsWith(`agent/${cat.dir}/`) &&
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
                  <NewResourceDialog kind={RESOURCE_KINDS[cat.key]} base={base} />
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
