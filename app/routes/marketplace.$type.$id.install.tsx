/**
 * Recruit — the install wizard (PRD §7.8, Milestone 6 phase 2). "Install = a change-set": this
 * page turns a catalog template into staged drafts on the target's working set, then hands off
 * to the existing Deployment-tab publish/ship pipeline (it does NOT open a PR itself).
 *
 * SSR, searchParams-driven — the URL IS the wizard state (`?project&member&newMember`), so every
 * choice is a plain GET navigation with no client state machine and the loader re-derives the
 * whole plan on each step. The plan PREVIEW the loader returns is advisory; the action re-plans
 * from scratch server-side (never trusting the preview) before it stages anything.
 *
 * Target shapes (PRD §7.8): tool/skill/subagent install INTO an existing member; an agent
 * installs AS a new team member (team repos only). Deliberately punted here: agent → a new
 * standalone repo, and agent → subagent of an existing agent.
 */
import { authkitLoader, withAuth } from "@workos-inc/authkit-react-router";
import {
  Form,
  Link,
  data,
  redirect,
  useNavigate,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { AppShell, PageHeader } from "~/components/shell";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { syncTenant } from "~/auth/tenant.server";
import type { Agent } from "~/data/ports";
import { stageDeletions, stageDraft, listDrafts } from "~/drafts/drafts.server";
import { getAgentSource } from "~/github/cached.server";
import { fetchAgentSource, readAgentFile } from "~/github/repo.server";
import { contextPath } from "~/lib/paths";
import {
  catalogLocator,
  describeDependencies,
  packageJsonPathForRoot,
  planInstall,
  type DependencyDecision,
  type InstallTarget,
} from "~/marketplace/install.server";
import { overlayLock } from "~/marketplace/lock";
import { setSecretSandboxExposed } from "~/seams/oss/secret-store";
import {
  TEMPLATE_TYPES,
  isTemplateSlug,
  type TemplateManifest,
  type TemplateType,
} from "~/marketplace/manifest";
import { listProjects } from "~/db/queries.server";
import { resolveAgentContext } from "~/project/agent-context.server";
import { requireProject, requireRepo } from "~/project/guard.server";
import { getRuntime } from "~/seams/index.server";
import type { Route } from "./+types/marketplace.$type.$id.install";

const TYPE_BADGE: Record<TemplateType, string> = {
  agent: "Agent",
  tool: "Tool",
  skill: "Skill",
  subagent: "Subagent",
};

/** Narrow a URL param to a TemplateType, 404-ing on anything else. */
function parseType(param: string | undefined): TemplateType {
  if (TEMPLATE_TYPES.includes(param as TemplateType)) return param as TemplateType;
  throw data("Unknown template type", { status: 404 });
}

/** An agent template lands as a NEW member; everything else installs into an existing one. */
function isAgentTemplate(type: TemplateType): boolean {
  return type === "agent";
}

/**
 * Resolve a selected roster name to an install target. The single-agent repo's root agent is
 * recorded in the lock as `member: null` (its name is cosmetic); team members carry their name.
 */
function resolveMemberTarget(
  roster: Agent[],
  isTeam: boolean,
  selectedName: string | null,
): { target: Extract<InstallTarget, { kind: "member" }>; agent: Agent } | null {
  if (!selectedName) return null;
  const agent = roster.find((a) => a.name === selectedName);
  if (!agent) return null;
  return {
    agent,
    target: {
      kind: "member",
      memberName: isTeam ? agent.name : null,
      root: agent.root,
    },
  };
}

interface PreviewData {
  files: string[];
  deletions: string[];
  conflicts: string[];
  warnings: string[];
  deps: DependencyDecision[];
  secrets: Array<{ name: string; description?: string; sandbox?: boolean }>;
  isUpdate: boolean;
}

export const loader = (args: LoaderFunctionArgs) =>
  authkitLoader(
    args,
    async ({ auth }) => {
      const type = parseType(args.params.type);
      const id = args.params.id!;
      if (!isTemplateSlug(id)) throw data("Unknown template", { status: 404 });
      const { org } = await syncTenant(auth);

      let template;
      try {
        template = await getRuntime().catalog.template(type, id);
      } catch (error) {
        console.warn(`[install] template ${type}/${id} failed to load:`, error);
        throw data(`Template ${type}/${id} isn't in the catalog.`, { status: 404 });
      }

      const url = new URL(args.request.url);
      const projectId = url.searchParams.get("project");
      const selectedMember = url.searchParams.get("member");
      const newMemberName = url.searchParams.get("newMember");

      // Only connected repos can host an install.
      const all = org ? await listProjects(org.id) : [];
      const projects = all
        .filter((p) => p.repoInstallationId && p.repoOwner && p.repoName)
        .map((p) => ({ id: p.id, name: p.name }));

      const base = {
        org,
        type,
        manifest: template.manifest as TemplateManifest,
        projects,
        selectedProjectId: projectId,
        projectName: null as string | null,
        roster: [] as { name: string }[],
        isTeam: false,
        newMemberTemplate: isAgentTemplate(type),
        singleAgentInvalid: false,
        selectedMember,
        newMemberName,
        preview: null as PreviewData | null,
      };

      if (!projectId) return base;

      // Tenancy: never trust the id — requireProject scopes it to the org.
      const project = requireRepo(
        await requireProject(
          { user: auth.user, organizationId: auth.organizationId, role: auth.role },
          projectId,
        ),
      );
      const repo = { owner: project.repoOwner, repo: project.repoName };
      const [source, drafts, ctx] = await Promise.all([
        getAgentSource(project.repoInstallationId, repo),
        listDrafts(project.id),
        resolveAgentContext(project.id, null),
      ]);
      base.projectName = project.name;
      base.isTeam = ctx.isTeam;
      base.roster = ctx.roster.map((a) => ({ name: a.name }));

      const registry = catalogLocator();
      const draftPaths = drafts.map((d) => ({ path: d.path, content: d.content }));
      const lock = overlayLock(source.files["eden-lock.json"] ?? null, draftPaths);

      if (isAgentTemplate(type)) {
        // Agent → new team member. Single-agent repos can't gain a peer member here.
        if (!ctx.isTeam) {
          base.singleAgentInvalid = true;
          return base;
        }
        if (!newMemberName) return base;
        const plan = planInstall({
          template,
          registry,
          repoPaths: source.paths,
          drafts: draftPaths,
          packageJson: null,
          lock,
          rosterNames: ctx.roster.map((a) => a.name),
          target: { kind: "new-member", name: newMemberName },
        });
        base.preview = {
          files: plan.writes
            .filter((w) => w.path !== "eden-lock.json")
            .map((w) => w.path),
          deletions: plan.deletions,
          conflicts: plan.conflicts,
          warnings: plan.warnings,
          deps: describeDependencies(
            { eve: "latest", zod: "^3.23.0" },
            template.manifest.dependencies,
          ),
          secrets: plan.secrets,
          isUpdate: plan.isUpdate,
        };
        return base;
      }

      // Tool/skill/subagent → into an existing member.
      const resolved = resolveMemberTarget(ctx.roster, ctx.isTeam, selectedMember);
      if (!resolved) return base;

      // The target's current package.json (a staged draft wins) — needed only for the dep
      // merge, so skip the read entirely when the template ships no dependencies.
      const hasDeps =
        !!template.manifest.dependencies &&
        Object.keys(template.manifest.dependencies).length > 0;
      const pkgPath = packageJsonPathForRoot(resolved.target.root);
      const pkgDraft = drafts.find((d) => d.path === pkgPath);
      const packageJson = !hasDeps
        ? null
        : pkgDraft !== undefined
          ? pkgDraft.content
          : await readAgentFile(project.repoInstallationId, repo, pkgPath);

      const plan = planInstall({
        template,
        registry,
        repoPaths: source.paths,
        drafts: draftPaths,
        packageJson,
        lock,
        target: resolved.target,
      });
      let currentDeps: Record<string, string> | null = null;
      try {
        currentDeps = packageJson
          ? ((JSON.parse(packageJson).dependencies as Record<string, string>) ?? {})
          : null;
      } catch {
        currentDeps = null;
      }
      base.preview = {
        files: plan.writes
          .filter((w) => w.path !== "eden-lock.json")
          .map((w) => w.path),
        deletions: plan.deletions,
        conflicts: plan.conflicts,
        warnings: plan.warnings,
        deps: describeDependencies(currentDeps, template.manifest.dependencies),
        secrets: plan.secrets,
        isUpdate: plan.isUpdate,
      };
      return base;
    },
    { ensureSignedIn: true },
  );

export async function action(args: ActionFunctionArgs) {
  const auth = await withAuth(args);
  if (!auth.user) throw redirect("/login");
  const type = parseType(args.params.type);
  const id = args.params.id!;
  if (!isTemplateSlug(id)) throw data("Unknown template", { status: 404 });

  const form = await args.request.formData();
  if (String(form.get("intent")) !== "install") {
    return { error: "Unknown action." };
  }
  const projectId = String(form.get("project") ?? "");

  try {
    const project = requireRepo(
      await requireProject(
        {
          user: auth.user,
          organizationId: auth.organizationId ?? null,
          role: auth.role ?? null,
        },
        projectId,
      ),
    );
    const repo = { owner: project.repoOwner, repo: project.repoName };
    const template = await getRuntime().catalog.template(type, id);
    const ctx = await resolveAgentContext(project.id, null);
    // ACTIONS read raw — a stale read composed into a write could clobber newer content.
    const [source, drafts] = await Promise.all([
      fetchAgentSource(project.repoInstallationId, repo),
      listDrafts(project.id),
    ]);
    const registry = catalogLocator();
    const draftPaths = drafts.map((d) => ({ path: d.path, content: d.content }));
    const lock = overlayLock(source.files["eden-lock.json"] ?? null, draftPaths);

    let target: InstallTarget;
    let secretAgent: Agent | null = null;

    if (isAgentTemplate(type)) {
      if (!ctx.isTeam) {
        return { error: "Agent templates install as a new team member — this is a single-agent repo." };
      }
      const name = String(form.get("newMember") ?? "").trim();
      if (!name) return { error: "Name the new team member." };
      target = { kind: "new-member", name };
    } else {
      const selectedName = String(form.get("member") ?? "");
      const resolved = resolveMemberTarget(ctx.roster, ctx.isTeam, selectedName);
      if (!resolved) return { error: "Pick an agent to install into." };
      target = resolved.target;
      secretAgent = resolved.agent;
    }

    // The target's package.json: a STAGED DRAFT wins over the branch copy — merging over the
    // branch would silently drop dependencies a previously staged install already added.
    let packageJson: string | null = null;
    if (secretAgent && target.kind === "member") {
      const pkgPath = packageJsonPathForRoot(target.root);
      const pkgDraft = drafts.find((d) => d.path === pkgPath);
      packageJson =
        pkgDraft !== undefined
          ? pkgDraft.content
          : await readAgentFile(project.repoInstallationId, repo, pkgPath);
    }

    // Re-plan server-side; NEVER trust the preview. A conflict stages nothing.
    const plan = planInstall({
      template,
      registry,
      repoPaths: source.paths,
      drafts: draftPaths,
      packageJson,
      lock,
      rosterNames: ctx.roster.map((a) => a.name),
      target,
    });
    if (plan.conflicts.length > 0) {
      return {
        error: `Can't install — ${plan.conflicts.length} file(s) already exist and aren't from this template:\n${plan.conflicts.join("\n")}`,
      };
    }

    for (const write of plan.writes) {
      await stageDraft({
        projectId: project.id,
        path: write.path,
        content: write.content,
        createdBy: auth.user.id,
      });
    }
    if (plan.deletions.length > 0) {
      await stageDeletions(
        { projectId: project.id, paths: plan.deletions, createdBy: auth.user.id },
      );
    }

    // Member target: write the manifest's secrets that were filled in (agent-wide, null env).
    // New-member installs skip — the agent row doesn't exist until the member ships.
    if (secretAgent) {
      const secrets = getRuntime().secrets;
      for (const s of template.manifest.secrets ?? []) {
        const value = String(form.get(`secret:${s.name}`) ?? "").trim();
        if (!value) continue;
        const ref = {
          projectId: project.id,
          agentId: secretAgent.id,
          environmentId: null,
          key: s.name,
        };
        await secrets.set(ref, value);
        // Manifest opted this secret into the sandbox shell (EDEN_SANDBOX_ENV) — flip the
        // exposure flag now so the agent's terminal has its credentials on first deploy.
        // Secrets left blank get the flag when the user sets them, from Settings.
        if (s.sandbox) await setSecretSandboxExposed(ref, true, auth.user.id);
      }
    }

    const memberName =
      target.kind === "new-member"
        ? null
        : (target.memberName ?? undefined);
    throw redirect(
      `${contextPath(project.id, memberName ?? undefined)}/deployment?installed=${encodeURIComponent(id)}`,
    );
  } catch (error) {
    if (error instanceof Response) throw error;
    return { error: (error as Error).message };
  }
}

export function meta() {
  return [{ title: "Install · Marketplace · Eden" }];
}

export default function InstallWizard({ loaderData, actionData }: Route.ComponentProps) {
  const {
    user,
    org,
    type,
    manifest,
    projects,
    selectedProjectId,
    projectName,
    roster,
    isTeam,
    newMemberTemplate,
    singleAgentInvalid,
    selectedMember,
    newMemberName,
    preview,
  } = loaderData;
  const navigate = useNavigate();

  const backTo = `/marketplace/${type}/${manifest.id}`;
  const hasConflicts = (preview?.conflicts.length ?? 0) > 0;
  const targetChosen = newMemberTemplate ? !!newMemberName : !!selectedMember;
  const canSubmit =
    !!selectedProjectId && targetChosen && !hasConflicts && !singleAgentInvalid;

  /** Navigate to this route with an updated query, preserving the rest. */
  const go = (patch: Record<string, string | null>) => {
    const params = new URLSearchParams();
    if (selectedProjectId) params.set("project", selectedProjectId);
    if (selectedMember) params.set("member", selectedMember);
    if (newMemberName) params.set("newMember", newMemberName);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) params.delete(k);
      else params.set(k, v);
    }
    navigate(`?${params.toString()}`);
  };

  return (
    <AppShell workspaceName={org?.name} userEmail={user.email}>
      <div className="mb-4">
        <Link
          to={backTo}
          prefetch="intent"
          className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          ← {manifest.name}
        </Link>
      </div>

      <PageHeader
        title={
          <span className="flex items-center gap-3">
            Install {manifest.name}
            <Badge variant="secondary">{TYPE_BADGE[manifest.type]}</Badge>
          </span>
        }
        description={manifest.description}
      />

      {actionData?.error && (
        <Alert variant="destructive" className="mb-6">
          <AlertTitle>Couldn&rsquo;t stage the install</AlertTitle>
          <AlertDescription className="whitespace-pre-wrap">
            {actionData.error}
          </AlertDescription>
        </Alert>
      )}

      <div className="space-y-6">
        {/* 1 — Target */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Target</CardTitle>
            <CardDescription>
              Where this {type} lands. Selecting keeps the choice in the URL.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-1.5">
              <Label>Repository</Label>
              {projects.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No connected repositories yet.{" "}
                  <Link to="/connect" className="underline underline-offset-4">
                    Connect one
                  </Link>{" "}
                  to install.
                </p>
              ) : (
                <Select
                  value={selectedProjectId ?? undefined}
                  onValueChange={(id) =>
                    navigate(`?project=${encodeURIComponent(id)}`)
                  }
                >
                  <SelectTrigger className="w-full max-w-sm">
                    <SelectValue placeholder="Pick a repository" />
                  </SelectTrigger>
                  <SelectContent>
                    {projects.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            {selectedProjectId && !newMemberTemplate && (
              <div className="grid gap-1.5">
                <Label>
                  {isTeam ? "Team member" : "Agent"}
                </Label>
                <Select
                  value={selectedMember ?? undefined}
                  onValueChange={(name) => go({ member: name })}
                >
                  <SelectTrigger className="w-full max-w-sm">
                    <SelectValue placeholder="Pick an agent to install into" />
                  </SelectTrigger>
                  <SelectContent>
                    {roster.map((m) => (
                      <SelectItem key={m.name} value={m.name}>
                        {m.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {selectedProjectId && newMemberTemplate && singleAgentInvalid && (
              <Alert>
                <AlertTitle>Not a valid target</AlertTitle>
                <AlertDescription>
                  <span className="font-medium">{projectName}</span> is a
                  single-agent repository. Agent templates install as a new
                  member of a <span className="font-medium">team</span> repo. Add
                  this to a team, or (punted) install it as its own new repo.
                </AlertDescription>
              </Alert>
            )}

            {selectedProjectId && newMemberTemplate && !singleAgentInvalid && (
              <Form method="get" className="grid max-w-sm gap-1.5">
                <input type="hidden" name="project" value={selectedProjectId} />
                <Label htmlFor="newMember">New team member name</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="newMember"
                    name="newMember"
                    defaultValue={newMemberName ?? ""}
                    placeholder="deployer"
                    className="font-mono"
                  />
                  <Button type="submit" variant="secondary">
                    Set
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Lowercase, digits, single hyphens — becomes{" "}
                  <span className="font-mono">agents/&lt;name&gt;/</span>.
                </p>
              </Form>
            )}
          </CardContent>
        </Card>

        {/* 2 — What this installs */}
        {preview && (
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <CardTitle className="text-base">What this installs</CardTitle>
                {preview.isUpdate && <Badge variant="outline">update</Badge>}
              </div>
            </CardHeader>
            <CardContent className="space-y-5">
              {preview.conflicts.length > 0 && (
                <Alert variant="destructive">
                  <AlertTitle>Blocked by conflicts</AlertTitle>
                  <AlertDescription>
                    <p className="mb-2">
                      These target files already exist and aren&rsquo;t from this
                      template. Resolve them before installing:
                    </p>
                    <ul className="space-y-1 font-mono text-xs">
                      {preview.conflicts.map((c) => (
                        <li key={c}>{c}</li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              )}

              <div>
                <h3 className="mb-2 text-sm font-medium">Files</h3>
                <ul className="divide-y rounded-lg border text-sm">
                  {preview.files.map((f) => (
                    <li key={f} className="px-3 py-1.5 font-mono text-xs">
                      {f}
                    </li>
                  ))}
                </ul>
              </div>

              {preview.deletions.length > 0 && (
                <div>
                  <h3 className="mb-2 text-sm font-medium">
                    Removed by this update
                  </h3>
                  <ul className="divide-y rounded-lg border text-sm">
                    {preview.deletions.map((f) => (
                      <li
                        key={f}
                        className="px-3 py-1.5 font-mono text-xs line-through decoration-destructive/60"
                      >
                        {f}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {preview.deps.length > 0 && (
                <div>
                  <h3 className="mb-2 text-sm font-medium">npm dependencies</h3>
                  <ul className="space-y-1 text-sm">
                    {preview.deps.map((d) => (
                      <li key={d.name} className="flex items-center gap-2">
                        <span className="font-mono text-xs">
                          {d.name}
                          <span className="text-muted-foreground"> {d.range}</span>
                        </span>
                        <DepBadge status={d.status} />
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {preview.warnings.length > 0 && (
                <Alert>
                  <AlertTitle>Review before merging</AlertTitle>
                  <AlertDescription>
                    <ul className="space-y-1">
                      {preview.warnings.map((w) => (
                        <li key={w}>{w}</li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>
        )}

        {/* 3 — Secrets + submit */}
        {preview && (
          <Form method="post">
            <input type="hidden" name="intent" value="install" />
            <input type="hidden" name="project" value={selectedProjectId ?? ""} />
            {newMemberTemplate ? (
              <input type="hidden" name="newMember" value={newMemberName ?? ""} />
            ) : (
              <input type="hidden" name="member" value={selectedMember ?? ""} />
            )}

            {preview.secrets.length > 0 && (
              <Card className="mb-6">
                <CardHeader>
                  <CardTitle className="text-base">Secrets</CardTitle>
                  <CardDescription>
                    {newMemberTemplate
                      ? "This agent needs these — set them after the member ships, from its Settings."
                      : "Stored per-agent, agent-wide. Leave blank to set later in Settings."}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {preview.secrets.map((s) => (
                    <div key={s.name} className="grid max-w-md gap-1.5">
                      <Label htmlFor={`secret:${s.name}`} className="font-mono text-xs">
                        {s.name}
                      </Label>
                      {s.description && (
                        <p className="text-xs text-muted-foreground">
                          {s.description}
                        </p>
                      )}
                      {s.sandbox && (
                        <p className="text-xs text-muted-foreground">
                          Made available in the agent's sandbox shell on install — its
                          terminal reads this from the environment.
                        </p>
                      )}
                      <Input
                        id={`secret:${s.name}`}
                        name={`secret:${s.name}`}
                        type="password"
                        autoComplete="off"
                        disabled={newMemberTemplate}
                        placeholder={
                          newMemberTemplate ? "set after the member ships" : "value (write-only)"
                        }
                        className="font-mono"
                      />
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            <div className="flex items-center gap-3">
              <Button type="submit" disabled={!canSubmit}>
                Stage install
              </Button>
              <span className="text-sm text-muted-foreground">
                Stages a change-set — review and publish it on the Deployment
                tab.
              </span>
            </div>
          </Form>
        )}
      </div>
    </AppShell>
  );
}

function DepBadge({ status }: { status: DependencyDecision["status"] }) {
  if (status === "add") return <Badge variant="secondary">add</Badge>;
  if (status === "keep") return <Badge variant="outline">already present</Badge>;
  return (
    <Badge variant="outline" className="border-destructive/40 text-destructive">
      range conflict
    </Badge>
  );
}
