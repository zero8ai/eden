/**
 * Resource category list — the management surface behind each overview card. Every file in
 * the category (repo + staged-new drafts) with last-commit metadata, open-in-editor, and a
 * git-native delete: removing a resource opens a change request (a staged-only draft is
 * just discarded). Member-scoped (M5.8): team members' lists live at
 * /repos/:id/agents/:name/resources/:category; single-agent repos at the repo level.
 */
import { authkitLoader, withAuth } from "@workos-inc/authkit-react-router";
import { MoreHorizontal } from "lucide-react";
import {
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
import { AgentNav, AppShell, PageHeader, repoCrumbs } from "~/components/shell";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { discardDrafts, listDrafts } from "~/drafts/drafts.server";
import { buildAgentConfig } from "~/eve/parse";
import { RESOURCE_KINDS } from "~/eve/templates";
import { AGENT_CATEGORIES } from "~/eve/types";
import {
  fetchAgentSource,
  fetchLastCommitForPaths,
  type LastCommitInfo,
} from "~/github/repo.server";
import { proposeChange } from "~/github/write.server";
import { contextPath } from "~/lib/paths";
import {
  agentFromParams,
  agentParamRedirect,
  resolveAgentContext,
} from "~/project/agent-context.server";
import { requireProject, requireRepo } from "~/project/guard.server";
import type { Route } from "./+types/projects.$projectId.resources.$category";

function categoryOf(param: string | undefined) {
  const cat = AGENT_CATEGORIES.find((c) => c.key === param);
  if (!cat) throw data("Unknown resource category", { status: 404 });
  return cat;
}

interface ResourceRow {
  name: string;
  path: string;
  isDirectory: boolean;
  staged: boolean;
  /** Exists in the repo (false == staged-new, not merged anywhere yet). */
  inRepo: boolean;
  lastCommit: LastCommitInfo | null;
}

export const loader = (args: LoaderFunctionArgs) =>
  authkitLoader(
    args,
    async ({ auth }) => {
      const cat = categoryOf(args.params.category);
      const project = requireRepo(
        await requireProject(
          { user: auth.user, organizationId: auth.organizationId, role: auth.role },
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
      // Teams have no repo-level resource lists — they exist only at the member level.
      if (isTeam && !agentName) throw redirect(`/repos/${project.id}`);
      const repo = { owner: project.repoOwner, repo: project.repoName };
      const [source, drafts] = await Promise.all([
        fetchAgentSource(project.repoInstallationId, repo),
        listDrafts(project.id),
      ]);

      const config = buildAgentConfig(source, active.root);
      const repoItems = config[cat.key];
      const draftPaths = new Set(drafts.map((d) => d.path));
      const stagedNew = drafts.flatMap((d) =>
        d.path.startsWith(`${active.root}/${cat.dir}/`) &&
        !repoItems.some((i) => i.path === d.path)
          ? [{ name: d.path.split("/").pop()!, path: d.path, isDirectory: false }]
          : [],
      );

      // Last-commit metadata for repo-backed files only (best-effort; page renders without).
      const commitMeta = await fetchLastCommitForPaths(
        project.repoInstallationId,
        repo,
        repoItems.map((i) => i.path),
      );

      const rows: ResourceRow[] = [
        ...repoItems.map((i) => ({
          ...i,
          staged: draftPaths.has(i.path),
          inRepo: true,
          lastCommit: commitMeta[i.path] ?? null,
        })),
        ...stagedNew.map((i) => ({ ...i, staged: true, inRepo: false, lastCommit: null })),
      ];

      return {
        project,
        category: { key: cat.key, label: cat.label },
        roster: roster.map((a) => ({ name: a.name })),
        activeAgent: active.name,
        activeRoot: active.root,
        isTeam,
        rows,
      };
    },
    { ensureSignedIn: true },
  );

export async function action(args: ActionFunctionArgs) {
  const auth = await withAuth(args);
  if (!auth.user) throw redirect("/login");
  const cat = categoryOf(args.params.category);
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
  if (String(form.get("intent")) !== "delete-resource") return { error: "Unknown action." };
  const target = String(form.get("path") ?? "");
  const { active } = await resolveAgentContext(
    project.id,
    String(form.get("agent") ?? "") || null,
  );
  // The path must be a resource of THIS member's category — no arbitrary deletions.
  if (!target.startsWith(`${active.root}/${cat.dir}/`) || target.includes("..")) {
    return { error: "Invalid resource path." };
  }

  const repo = { owner: project.repoOwner, repo: project.repoName };
  const name = target.split("/").pop()!;

  try {
    const [source, drafts] = await Promise.all([
      fetchAgentSource(project.repoInstallationId, repo),
      listDrafts(project.id),
    ]);
    // Directory resources delete every file under them; files delete themselves.
    const repoFiles = source.paths.filter((p) => p === target || p.startsWith(`${target}/`));
    const stagedHere = drafts
      .map((d) => d.path)
      .filter((p) => p === target || p.startsWith(`${target}/`));

    // Anything staged goes away regardless (a deletion supersedes pending edits).
    if (stagedHere.length > 0) await discardDrafts(project.id, stagedHere);

    if (repoFiles.length === 0) {
      // Staged-new only — never merged; discarding the draft was the whole delete.
      return { ok: true as const, discarded: name };
    }

    const change = await proposeChange(project.repoInstallationId, repo, {
      base: project.defaultBranch,
      branch: `eden/delete-${cat.key}-${name.replace(/[^A-Za-z0-9._-]+/g, "-")}`,
      files: repoFiles.map((p) => ({ path: p, content: null })),
      title: `Remove ${cat.label.toLowerCase().replace(/s$/, "")}: ${name}`,
      body: `Deletes \`${target}\` (${repoFiles.length} file${repoFiles.length === 1 ? "" : "s"}). Nothing is removed until this merges, and git can restore it after.`,
    });
    return { ok: true as const, changeUrl: change.pullRequestUrl, deleted: name };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

export function meta({ params }: Route.MetaArgs) {
  const label = AGENT_CATEGORIES.find((c) => c.key === params.category)?.label ?? "Resources";
  return [{ title: `${label} · Eden` }];
}

function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

const CATEGORY_HINTS: Record<string, string> = {
  tools: "TypeScript functions the agent can call",
  skills: "On-demand Markdown playbooks",
  subagents: "Specialist child agents this one delegates to",
  channels: "Entry points — HTTP, Slack, web chat",
  schedules: "Recurring cron-triggered runs",
  connections: "Typed external integrations",
};

export default function ResourceCategory({ loaderData, actionData }: Route.ComponentProps) {
  const { project, category, roster, activeAgent, activeRoot, isTeam, rows } = loaderData;
  const ctx = contextPath(project.id, isTeam ? activeAgent : null);
  const submit = useSubmit();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const kind = RESOURCE_KINDS[category.key];

  return (
    <AppShell
      breadcrumbs={repoCrumbs({
        projectId: project.id,
        repoName: project.name,
        isTeam,
        agentName: activeAgent,
        tail: [{ label: category.label }],
      })}
    >
      <PageHeader
        title={category.label}
        description={CATEGORY_HINTS[category.key]}
        actions={<NewResourceDialog kind={kind} base={ctx} root={activeRoot} />}
      />
      <AgentNav
        base={ctx}
        level={isTeam ? "member" : "single"}
        roster={roster}
        activeAgent={isTeam ? activeAgent : undefined}
      />

      {actionData?.error && (
        <Alert variant="destructive" className="mb-6">
          <AlertTitle>Couldn&rsquo;t delete</AlertTitle>
          <AlertDescription>{actionData.error}</AlertDescription>
        </Alert>
      )}
      {actionData?.ok && "changeUrl" in actionData && (
        <Alert className="mb-6">
          <AlertTitle>Change request opened</AlertTitle>
          <AlertDescription>
            <span className="font-mono">{actionData.deleted}</span> is removed when it
            merges.{" "}
            <Link
              to={`${ctx}/deployment`}
              className="font-medium underline underline-offset-4"
            >
              Review it on the Deployment tab →
            </Link>
          </AlertDescription>
        </Alert>
      )}
      {actionData?.ok && "discarded" in actionData && (
        <Alert className="mb-6">
          <AlertTitle>Draft discarded</AlertTitle>
          <AlertDescription>
            <span className="font-mono">{actionData.discarded}</span> was only staged — it
            never reached the repository, so discarding the draft removed it entirely.
          </AlertDescription>
        </Alert>
      )}

      {rows.length === 0 ? (
        <Card className="border-dashed">
          <CardHeader className="items-center py-12 text-center">
            <CardTitle className="text-lg">No {category.label.toLowerCase()} yet</CardTitle>
            <CardDescription>{CATEGORY_HINTS[category.key]}</CardDescription>
            <div className="mt-4">
              <NewResourceDialog kind={kind} base={ctx} root={activeRoot} />
            </div>
          </CardHeader>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last updated</TableHead>
                  <TableHead>By</TableHead>
                  <TableHead className="w-24 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.path}>
                    <TableCell>
                      {row.isDirectory ? (
                        <span className="font-mono">{row.name}/</span>
                      ) : (
                        <Link
                          to={`${ctx}/edit?path=${encodeURIComponent(row.path)}`}
                          className="font-mono underline-offset-4 hover:underline"
                        >
                          {row.name}
                        </Link>
                      )}
                    </TableCell>
                    <TableCell>
                      {row.staged && (
                        <Badge variant="outline" className="text-xs">
                          {row.inRepo ? "staged edit" : "staged — new"}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {relativeTime(row.lastCommit?.date ?? null)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {row.lastCommit?.authorLogin ?? row.lastCommit?.authorName ?? "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        {!row.isDirectory && (
                          <Button variant="ghost" size="sm" asChild>
                            <Link to={`${ctx}/edit?path=${encodeURIComponent(row.path)}`}>
                              Open
                            </Link>
                          </Button>
                        )}
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              aria-label={`More actions for ${row.name}`}
                              disabled={busy}
                            >
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <ConfirmDialog
                              trigger={
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="w-full justify-start text-destructive hover:text-destructive"
                                >
                                  Delete
                                </Button>
                              }
                              title={`Delete ${row.name}?`}
                              description={
                                row.inRepo
                                  ? `Opens a change request removing ${row.path}. Nothing is deleted until it merges, and git can restore it after.`
                                  : `${row.name} is only a staged draft — deleting discards it immediately.`
                              }
                              confirmLabel={row.inRepo ? "Open change request" : "Discard draft"}
                              onConfirm={() =>
                                submit(
                                  {
                                    intent: "delete-resource",
                                    path: row.path,
                                    agent: activeAgent,
                                  },
                                  { method: "post" },
                                )
                              }
                            />
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </AppShell>
  );
}
