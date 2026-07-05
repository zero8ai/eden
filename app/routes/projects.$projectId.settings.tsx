/**
 * Settings — configuration that isn't the agent's repo-backed behavior (M5.8).
 *
 * Two levels share this module (route ids `settings` + `member-settings`):
 *  - MEMBER sections (team members at /agents/:name/settings; included for single-agent
 *    repos): Model (staged into agent.ts like any edit), Secrets (per-member + per-
 *    environment, write-only values), Marketplace installs, and the member danger zone
 *    (remove agent — a change-set PR deleting its directory).
 *  - REPO sections (team repos at /repos/:id/settings; appended for single-agent repos):
 *    Marketplace installs, General (the GitHub connection), Run ingestion tokens, and the repo
 *    danger zone — Delete repository, a FULL Eden-side teardown (instances stopped and
 *    destroyed, every row cascaded). The GitHub repository itself is never touched.
 */
import { authkitLoader, withAuth } from "@workos-inc/authkit-react-router";
import { useMemo, useState } from "react";
import {
  Form,
  Link,
  redirect,
  useFetcher,
  useNavigation,
  useSearchParams,
  useSubmit,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";
import semver from "semver";

import { ConfirmDialog } from "~/components/confirm-dialog";
import { ModelSelect } from "~/components/model-select";
import {
  AgentNav,
  AppShell,
  PageHeader,
  SectionHeader,
  repoCrumbs,
  type NavLevel,
} from "~/components/shell";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
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
import type { Environment } from "~/data/ports";
import { deleteRepository } from "~/deploy/repository.server";
import { listAgentEnvironments } from "~/db/queries.server";
import {
  createIngestToken,
  listIngestTokens,
} from "~/observability/store.server";
import {
  listDrafts,
  resolveFileView,
  stageDeletions,
  stageDraft,
} from "~/drafts/drafts.server";
import {
  ensureOpenRouterDependency,
  readModel,
  scaffoldAgentModule,
  setModel,
} from "~/eve/agentModule";
import { buildAgentConfig } from "~/eve/parse";
import { getAgentSource } from "~/github/cached.server";
import { fetchAgentSource, readAgentFile } from "~/github/repo.server";
import { proposeChange, type FileChange } from "~/github/write.server";
import { contextPath } from "~/lib/paths";
import {
  catalogLocator,
  packageJsonPathForRoot,
  planInstall,
  planUninstall,
} from "~/marketplace/install.server";
import { overlayLock } from "~/marketplace/lock";
import type { TemplateType } from "~/marketplace/manifest";
import { findModel } from "~/models/catalog.server";
import { getWorkspaceAssistantModel } from "~/org/workspace.server";
import {
  agentFromParams,
  agentParamRedirect,
  resolveAgentContext,
  resolveSyncedAgentContext,
} from "~/project/agent-context.server";
import { requireProject, requireRepo } from "~/project/guard.server";
import type { ConnectedProject } from "~/project/guard.server";
import { getRuntime } from "~/seams/index.server";
import type { Route } from "./+types/projects.$projectId.settings";

const ALL = "all";

interface SettingsView {
  project: ConnectedProject;
  roster: { name: string }[];
  activeAgent: string;
  isTeam: boolean;
  level: NavLevel;
  showMember: boolean;
  showRepo: boolean;
  /** Member: whether the active member can be removed (team, not the last member). */
  canRemoveMember: boolean;
  /** Member: current model (staged draft wins) + staging state. */
  model: string | null;
  modelInherited: boolean;
  hasAgentModule: boolean;
  modelStaged: boolean;
  /** Member: secrets scope state. */
  envs: Environment[];
  scope: { environmentId: string | null; label: string };
  secretNames: string[];
  secretsConfigured: boolean;
  secretsError: string | null;
  /** Marketplace installs in the current settings scope. */
  installs: InstallDisplay[];
  /** Repo: ingest tokens. */
  tokens: {
    id: string;
    name: string;
    createdAt: string;
    lastUsedAt: string | null;
  }[];
}

/** A marketplace install as Settings shows it: provenance + update availability. */
interface InstallDisplay {
  id: string;
  type: TemplateType;
  name: string;
  version: string;
  /** Owning member; null = the single-agent repo's root agent. */
  member: string | null;
  /** Files uninstall would delete (from the lock). */
  files: string[];
  /** npm packages uninstall leaves for the reviewer to prune. */
  depsLeft: string[];
  /** The newer catalog version when an update is available, else null. */
  update: string | null;
}

/** Resolve the `?env=` param to an environmentId (null == agent-wide), validated. */
function resolveScope(
  raw: string | null,
  envs: Environment[],
): { environmentId: string | null; label: string } {
  if (!raw || raw === ALL)
    return { environmentId: null, label: "All environments" };
  const env = envs.find((e) => e.id === raw);
  return env
    ? { environmentId: env.id, label: env.name }
    : { environmentId: null, label: "All environments" };
}

/**
 * Build install display rows from the effective lock, tagging each with the newer catalog version
 * when one exists. The catalog is optional; when it is unavailable, rows simply show no updates.
 */
function buildInstalls(
  lock: ReturnType<typeof overlayLock>,
  index: { id: string; type: TemplateType; version: string }[],
  keep: (member: string | null) => boolean,
): InstallDisplay[] {
  return lock.installs.reduce<InstallDisplay[]>((rows, entry) => {
    if (!keep(entry.member)) return rows;
    const row = index.find((r) => r.id === entry.id && r.type === entry.type);
    let update: string | null = null;
    try {
      if (row && semver.gt(row.version, entry.version)) update = row.version;
    } catch {
      update = null;
    }
    rows.push({
      id: entry.id,
      type: entry.type,
      name: entry.name,
      version: entry.version,
      member: entry.member,
      files: entry.files,
      depsLeft: Object.keys(entry.dependencies ?? {}),
      update,
    });
    return rows;
  }, []);
}

export const loader = (args: LoaderFunctionArgs) =>
  authkitLoader(
    args,
    async ({ auth }): Promise<SettingsView> => {
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
      const repo = { owner: project.repoOwner, repo: project.repoName };
      const [source, drafts] = await Promise.all([
        getAgentSource(project.repoInstallationId, repo),
        listDrafts(project.id),
      ]);
      const { roster, active, isTeam } = await resolveSyncedAgentContext(
        project.id,
        agentName,
        source.paths,
      );
      const level: NavLevel = agentName ? "member" : isTeam ? "repo" : "single";
      const showMember = level !== "repo";
      const showRepo = level !== "member";
      const draftPaths = drafts.map((d) => ({
        path: d.path,
        content: d.content,
      }));
      const lock = overlayLock(
        source.files["eden-lock.json"] ?? null,
        draftPaths,
      );
      let index: { id: string; type: TemplateType; version: string }[] = [];
      if (lock.installs.length > 0) {
        try {
          index = (await getRuntime().catalog.index()).templates;
        } catch (error) {
          console.warn("[settings] catalog index unavailable:", error);
        }
      }

      const base: SettingsView = {
        project,
        roster: roster.map((a) => ({ name: a.name })),
        activeAgent: active.name,
        isTeam,
        level,
        showMember,
        showRepo,
        canRemoveMember: showMember && isTeam && active.root !== "agent",
        model: null,
        modelInherited: false,
        hasAgentModule: false,
        modelStaged: false,
        envs: [],
        scope: { environmentId: null, label: "All environments" },
        secretNames: [],
        secretsConfigured: true,
        secretsError: null,
        installs: buildInstalls(
          lock,
          index,
          level === "repo"
            ? () => true
            : (member) =>
                member === active.name || (member === null && !isTeam),
        ),
        tokens: [],
      };

      if (showMember) {
        const [envs, orgDefaultModel] = await Promise.all([
          listAgentEnvironments(active.id),
          getWorkspaceAssistantModel(project.orgId).catch(() => null),
        ]);
        const config = buildAgentConfig(source, active.root);
        // The model shown must reflect the newest intent: a staged agent.ts draft wins.
        // A deletion draft (content null) carries no model — fall back to the repo value.
        const agentTsDraft = drafts.find(
          (d) => d.path === `${active.root}/agent.ts` && d.content !== null,
        );
        const agentModel = agentTsDraft?.content
          ? (readModel(agentTsDraft.content) ?? config.model)
          : config.model;
        base.model = agentModel ?? orgDefaultModel;
        base.modelInherited = !agentModel && !!orgDefaultModel;
        base.hasAgentModule = config.hasAgentModule || !!agentTsDraft;
        base.modelStaged = !!agentTsDraft;
        base.envs = envs;
        base.scope = resolveScope(
          new URL(args.request.url).searchParams.get("env"),
          envs,
        );
        try {
          base.secretNames = await getRuntime().secrets.listNames({
            projectId: project.id,
            agentId: active.id,
            environmentId: base.scope.environmentId,
          });
        } catch (error) {
          base.secretsConfigured = false;
          base.secretsError = (error as Error).message;
        }
      }
      if (showRepo) {
        const tokens = await listIngestTokens(project.id);
        base.tokens = tokens.map((t) => ({
          id: t.id,
          name: t.name,
          createdAt: new Date(t.createdAt).toISOString(),
          lastUsedAt: t.lastUsedAt
            ? new Date(t.lastUsedAt).toISOString()
            : null,
        }));
      }
      return base;
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
  const back = `${contextPath(project.id, agentFromParams(args.params))}/settings`;
  const repo = { owner: project.repoOwner, repo: project.repoName };

  try {
    // ── Model: stage agent.ts for the active member (same rails as every edit) ──
    if (intent === "set-model") {
      const model = String(form.get("model") ?? "").trim();
      if (!model) return { error: "Pick or enter a model." };
      const modelInfo = await findModel(model);
      const { active } = await resolveAgentContext(
        project.id,
        String(form.get("agent") ?? "") || null,
      );
      const path = `${active.root}/agent.ts`;
      const view = await resolveFileView(project, path);
      const next = view.content
        ? setModel(view.content, model, {
            contextWindowTokens: modelInfo?.contextWindow,
          })
        : scaffoldAgentModule(model, {
            contextWindowTokens: modelInfo?.contextWindow,
          });

      const pkgPath = packageJsonPathForRoot(active.root);
      const pkgView = await resolveFileView(project, pkgPath);
      let packageJson: string;
      try {
        packageJson = ensureOpenRouterDependency(pkgView.content);
      } catch {
        return { error: `${pkgPath} is not valid JSON — fix it before setting the model.` };
      }

      await Promise.all([
        stageDraft({
          projectId: project.id,
          path,
          content: next,
          createdBy: auth.user.id,
        }),
        packageJson !== pkgView.content
          ? stageDraft({
              projectId: project.id,
              path: pkgPath,
              content: packageJson,
              createdBy: auth.user.id,
            })
          : Promise.resolve(),
      ]);
      return { ok: true as const };
    }

    // ── Marketplace installs: update / uninstall stage reviewable repo changes ──
    if (intent === "update-install") {
      const type = String(form.get("type") ?? "") as TemplateType;
      const id = String(form.get("id") ?? "");
      const member = String(form.get("member") ?? "") || null;
      if (!type || !id) return { error: "Missing install to update." };
      // Actions read raw — a stale read merged into a write could clobber newer content.
      const [template, source, drafts] = await Promise.all([
        getRuntime().catalog.template(type, id),
        fetchAgentSource(project.repoInstallationId, repo),
        listDrafts(project.id),
      ]);
      const { roster, active } = await resolveSyncedAgentContext(
        project.id,
        member,
        source.paths,
      );
      const draftPaths = drafts.map((d) => ({
        path: d.path,
        content: d.content,
      }));
      const lock = overlayLock(
        source.files["eden-lock.json"] ?? null,
        draftPaths,
      );
      // A staged package.json draft wins over the branch copy — otherwise a second staged
      // install/update could silently drop dependencies added by the first.
      const pkgPath = packageJsonPathForRoot(active.root);
      const pkgDraft = drafts.find((d) => d.path === pkgPath);
      const packageJson =
        pkgDraft !== undefined
          ? pkgDraft.content
          : await readAgentFile(project.repoInstallationId, repo, pkgPath);
      const plan = planInstall({
        template,
        registry: catalogLocator(),
        repoPaths: source.paths,
        drafts: draftPaths,
        packageJson,
        lock,
        rosterNames: roster.map((a) => a.name),
        target: { kind: "member", memberName: member, root: active.root },
      });
      if (plan.conflicts.length > 0) {
        return {
          error: `Update blocked — these files were changed locally:\n${plan.conflicts.join("\n")}`,
        };
      }
      await Promise.all(
        plan.writes.map((w) =>
          stageDraft({
            projectId: project.id,
            path: w.path,
            content: w.content,
            createdBy: auth.user.id,
          }),
        ),
      );
      if (plan.deletions.length > 0) {
        await stageDeletions({
          projectId: project.id,
          paths: plan.deletions,
          createdBy: auth.user.id,
        });
      }
      throw redirect(`${back}?updated=${encodeURIComponent(id)}`);
    }
    if (intent === "uninstall") {
      const id = String(form.get("id") ?? "");
      const member = String(form.get("member") ?? "") || null;
      if (!id) return { error: "Missing install to remove." };
      const [source, drafts] = await Promise.all([
        fetchAgentSource(project.repoInstallationId, repo),
        listDrafts(project.id),
      ]);
      const draftPaths = drafts.map((d) => ({
        path: d.path,
        content: d.content,
      }));
      const lock = overlayLock(
        source.files["eden-lock.json"] ?? null,
        draftPaths,
      );
      const plan = planUninstall({
        lock,
        id,
        memberName: member,
        repoPaths: source.paths,
      });
      if (plan.notFound) {
        return { error: "That install isn't recorded in eden-lock.json." };
      }
      if (plan.deletions.length > 0) {
        await stageDeletions({
          projectId: project.id,
          paths: plan.deletions,
          createdBy: auth.user.id,
        });
      }
      await stageDraft({
        projectId: project.id,
        path: plan.lockWrite.path,
        content: plan.lockWrite.content,
        createdBy: auth.user.id,
      });
      throw redirect(`${back}?uninstalled=${encodeURIComponent(id)}`);
    }

    // ── Secrets (per-member + per-environment; values write-only) ──
    if (intent === "secret-set" || intent === "secret-delete") {
      const { active } = await resolveAgentContext(
        project.id,
        String(form.get("agent") ?? "") || null,
      );
      const envs = await listAgentEnvironments(active.id);
      const envRaw = String(form.get("env") ?? ALL);
      const { environmentId } = resolveScope(envRaw, envs);
      const key = String(form.get("key") ?? "").trim();
      const ref = {
        projectId: project.id,
        agentId: active.id,
        environmentId,
        key,
      };
      const secrets = getRuntime().secrets;
      if (intent === "secret-set") {
        const value = String(form.get("value") ?? "");
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
          return { error: "Key must be a valid env var name (A–Z, 0–9, _)." };
        }
        if (!value) return { error: "Value is required." };
        await secrets.set(ref, value);
      } else {
        await secrets.delete(ref);
      }
      throw redirect(`${back}?env=${encodeURIComponent(envRaw)}`);
    }

    // ── Member danger zone: remove agent (change-set PR deleting its directory) ──
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
      const files: FileChange[] = source.paths.flatMap((p) =>
        p.startsWith(memberDir) ? [{ path: p, content: null }] : [],
      );
      if (files.length === 0)
        return { error: `No files found under ${memberDir}.` };
      const change = await proposeChange(project.repoInstallationId, repo, {
        base: project.defaultBranch,
        branch: `eden/remove-member-${name}`,
        files,
        title: `Remove team member: ${name}`,
        body:
          `Deletes \`agents/${name}/\` (${files.length} files). Merging removes the member; ` +
          `its releases and run history remain until then.`,
      });
      return {
        ok: true as const,
        changeUrl: change.pullRequestUrl,
        member: name,
      };
    }

    // ── Repo: ingest tokens ──
    if (intent === "create-token") {
      const token = await createIngestToken(
        project.id,
        String(form.get("name") || "ingest"),
      );
      return { ok: true as const, token };
    }

    // ── Repo danger zone: full Eden-side teardown ──
    if (intent === "delete-repository") {
      const confirm = String(form.get("confirm") ?? "");
      if (confirm !== project.name) {
        return {
          error: `Type the repository name ("${project.name}") to confirm.`,
        };
      }
      await deleteRepository({
        projectId: project.id,
        createdBy: auth.user.id,
      });
      throw redirect("/dashboard");
    }

    return { error: "Unknown action." };
  } catch (error) {
    if (error instanceof Response) throw error;
    return { error: (error as Error).message };
  }
}

export function meta() {
  return [{ title: "Settings · Eden" }];
}

export default function Settings({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const {
    project,
    roster,
    activeAgent,
    isTeam,
    level,
    showMember,
    showRepo,
    canRemoveMember,
  } = loaderData;
  const base = contextPath(project.id, level === "member" ? activeAgent : null);
  const [params] = useSearchParams();
  const justUpdated = params.get("updated");
  const justUninstalled = params.get("uninstalled");
  const newToken =
    actionData && "token" in actionData
      ? (actionData.token as string | null)
      : null;
  const changeUrl =
    actionData && "changeUrl" in actionData
      ? (actionData.changeUrl as string)
      : null;

  return (
    <AppShell
      breadcrumbs={repoCrumbs({
        projectId: project.id,
        repoName: project.name,
        isTeam: level === "member",
        agentName: activeAgent,
        tail: [{ label: "Settings" }],
      })}
    >
      <AgentNav
        base={base}
        level={level}
        roster={roster}
        activeAgent={level === "member" ? activeAgent : undefined}
      />
      <PageHeader
        title={level === "member" ? `Settings — ${activeAgent}` : "Settings"}
        description={
          level === "repo"
            ? "Repository-wide configuration. Each member's model and secrets live in the member's own Settings."
            : showRepo
              ? "This agent's runtime configuration and the repository connection."
              : "This member's runtime configuration — model, credentials, membership."
        }
      />

      {actionData?.error && (
        <Alert variant="destructive" className="mb-6">
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription className="whitespace-pre-wrap">
            {actionData.error}
          </AlertDescription>
        </Alert>
      )}
      {changeUrl && (
        <Alert className="mb-6">
          <AlertTitle>Change request opened</AlertTitle>
          <AlertDescription>
            The member is removed when it merges — review it on the Deployment
            tab.
          </AlertDescription>
        </Alert>
      )}
      {(justUpdated || justUninstalled) && (
        <Alert className="mb-6">
          <AlertTitle>
            {justUpdated
              ? `${justUpdated} update staged`
              : `${justUninstalled} uninstall staged`}
          </AlertTitle>
          <AlertDescription>
            Review and publish it from the Deployment tab.
          </AlertDescription>
        </Alert>
      )}

      <div className="space-y-10">
        {showMember && <ModelSection loaderData={loaderData} />}
        {showMember && <SecretsSection loaderData={loaderData} />}
        <MarketplaceInstallsSection loaderData={loaderData} />
        {showRepo && <GeneralSection project={project} />}
        {showRepo && (
          <IngestSection loaderData={loaderData} newToken={newToken} />
        )}
        {(canRemoveMember || showRepo) && (
          <DangerSection
            project={project}
            activeAgent={activeAgent}
            canRemoveMember={canRemoveMember}
            showRepo={showRepo}
            isTeam={isTeam}
          />
        )}
      </div>
    </AppShell>
  );
}

/** Model — the one runtime setting; saving stages agent.ts like any other edit. */
function ModelSection({
  loaderData,
}: {
  loaderData: Route.ComponentProps["loaderData"];
}) {
  const { model, modelInherited, hasAgentModule, modelStaged, activeAgent } =
    loaderData;
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const modelBadges = useMemo(
    () => (
      <>
        {modelStaged && (
          <Badge variant="outline" className="text-xs">
            staged
          </Badge>
        )}
        {modelInherited && (
          <Badge variant="outline" className="text-xs">
            inherited default
          </Badge>
        )}
        {!hasAgentModule && (
          <Badge variant="outline" className="text-xs">
            no agent.ts — picking one scaffolds it
          </Badge>
        )}
      </>
    ),
    [modelStaged, modelInherited, hasAgentModule],
  );
  return (
    <section>
      <SectionHeader title="Model" badges={modelBadges} />
      <ModelSelect
        value={model}
        busy={fetcher.state !== "idle"}
        onCommit={(m) =>
          fetcher.submit(
            { intent: "set-model", model: m, agent: activeAgent },
            { method: "post" },
          )
        }
      />
      {fetcher.data?.error && (
        <p className="mt-2 text-sm text-destructive">{fetcher.data.error}</p>
      )}
      {fetcher.data?.ok && (
        <p className="mt-2 text-sm text-muted-foreground">
          Staged — ship or publish it from the Deployment tab.
        </p>
      )}
    </section>
  );
}

/** Secrets — per-member, per-environment; values are write-only from the UI. */
function SecretsSection({
  loaderData,
}: {
  loaderData: Route.ComponentProps["loaderData"];
}) {
  const {
    envs,
    scope,
    secretNames,
    secretsConfigured,
    secretsError,
    activeAgent,
    isTeam,
  } = loaderData;
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";
  const envValue = scope.environmentId ?? ALL;
  const secretsBadge = useMemo(
    () => (
      <Badge variant="secondary">
        {scope.label} · {secretNames.length}
      </Badge>
    ),
    [scope.label, secretNames.length],
  );

  return (
    <section>
      <SectionHeader
        title="Secrets"
        badges={secretsBadge}
        actions={
          <Form method="get" className="flex items-center gap-2">
            <Select name="env" defaultValue={envValue}>
              <SelectTrigger className="h-8 min-w-44" aria-label="Secret scope">
                <SelectValue placeholder="Scope" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All environments</SelectItem>
                {envs.map((e) => (
                  <SelectItem key={e.id} value={e.id}>
                    {e.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button type="submit" size="sm" variant="secondary">
              Switch
            </Button>
          </Form>
        }
      />
      <p className="mb-3 text-sm text-muted-foreground">
        {isTeam
          ? "Scoped to this member only — teammates cannot read each other's credentials. Values are injected at deploy time and never shown again."
          : "Stored encrypted, never in the repo. Reference them by name in tools and connections; values are injected at deploy time and never shown again."}
      </p>

      {!secretsConfigured && (
        <Alert className="mb-4">
          <AlertTitle>Secrets store not configured.</AlertTitle>
          <AlertDescription>{secretsError}</AlertDescription>
        </Alert>
      )}

      {secretNames.length > 0 && (
        <ul className="mb-4 divide-y rounded-lg border text-sm">
          {secretNames.map((name) => (
            <li
              key={name}
              className="flex items-center justify-between gap-2 px-4 py-2"
            >
              <div className="flex items-center gap-2">
                <span className="font-mono">{name}</span>
                <Badge variant={scope.environmentId ? "secondary" : "outline"}>
                  {scope.environmentId ? scope.label : "all environments"}
                </Badge>
              </div>
              <Form method="post">
                <input type="hidden" name="intent" value="secret-delete" />
                <input type="hidden" name="env" value={envValue} />
                <input type="hidden" name="agent" value={activeAgent} />
                <input type="hidden" name="key" value={name} />
                <Button
                  type="submit"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  className="text-destructive hover:text-destructive"
                >
                  Delete
                </Button>
              </Form>
            </li>
          ))}
        </ul>
      )}

      <Form method="post" className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="intent" value="secret-set" />
        <input type="hidden" name="env" value={envValue} />
        <input type="hidden" name="agent" value={activeAgent} />
        <div className="grid gap-1.5">
          <Label htmlFor="secret-key">Key</Label>
          <Input
            id="secret-key"
            name="key"
            placeholder="API_KEY"
            className="w-56 font-mono"
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="secret-value">Value</Label>
          <Input
            id="secret-value"
            name="value"
            type="password"
            placeholder="value (write-only)"
            autoComplete="off"
            className="w-64 font-mono"
          />
        </div>
        <Button type="submit" disabled={busy || !secretsConfigured}>
          {busy ? "Saving…" : "Save secret"}
        </Button>
      </Form>
    </section>
  );
}

/**
 * Marketplace provenance from eden-lock.json. Updates and uninstalls stage normal repo changes;
 * Deployment remains the review/publish surface for those staged files.
 */
function MarketplaceInstallsSection({
  loaderData,
}: {
  loaderData: Route.ComponentProps["loaderData"];
}) {
  const { project, installs, level } = loaderData;
  const submit = useSubmit();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle" && navigation.formData != null;
  const showOwner = level === "repo";
  const installsBadge = useMemo(
    () => <Badge variant="secondary">{installs.length}</Badge>,
    [installs.length],
  );

  return (
    <section>
      <SectionHeader title="Marketplace installs" badges={installsBadge} />
      <Card>
        <CardContent className="py-4">
          {installs.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No marketplace installs recorded for this scope.
            </p>
          ) : (
            <ul className="divide-y rounded-lg border text-sm">
              {installs.map((install) => (
                <li
                  key={`${install.member ?? "root"}:${install.type}/${install.id}`}
                  className="flex flex-wrap items-center gap-3 px-3 py-2"
                >
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {install.name}
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">
                    v{install.version}
                  </span>
                  <Badge variant="outline">{install.type}</Badge>
                  {showOwner &&
                    (install.member ? (
                      <Link
                        to={`${contextPath(project.id, install.member)}/settings`}
                        className="text-xs underline-offset-4 hover:underline"
                      >
                        {install.member}
                      </Link>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        shared
                      </span>
                    ))}
                  {install.update && (
                    <Form method="post">
                      <input
                        type="hidden"
                        name="intent"
                        value="update-install"
                      />
                      <input type="hidden" name="type" value={install.type} />
                      <input type="hidden" name="id" value={install.id} />
                      <input
                        type="hidden"
                        name="member"
                        value={install.member ?? ""}
                      />
                      <Button
                        type="submit"
                        size="sm"
                        variant="secondary"
                        disabled={busy}
                      >
                        Update to {install.update}
                      </Button>
                    </Form>
                  )}
                  <ConfirmDialog
                    trigger={
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                        disabled={busy}
                      >
                        Uninstall
                      </Button>
                    }
                    title={`Uninstall ${install.name}?`}
                    description={
                      `Stages a change-set deleting ${install.files.length} file${install.files.length === 1 ? "" : "s"}:\n` +
                      install.files.join("\n") +
                      (install.depsLeft.length > 0
                        ? `\n\nnpm packages left for review: ${install.depsLeft.join(", ")}`
                        : "")
                    }
                    confirmLabel="Uninstall"
                    onConfirm={() =>
                      submit(
                        {
                          intent: "uninstall",
                          id: install.id,
                          member: install.member ?? "",
                        },
                        { method: "post" },
                      )
                    }
                  />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

/** The GitHub connection this repository is built on (read-mostly). */
function GeneralSection({
  project,
}: {
  project: {
    name: string;
    repoOwner: string;
    repoName: string;
    defaultBranch: string;
  };
}) {
  return (
    <section>
      <SectionHeader title="General" />
      <Card>
        <CardContent className="space-y-1 py-4 text-sm">
          <p>
            <span className="text-muted-foreground">Repository:</span>{" "}
            <a
              href={`https://github.com/${project.repoOwner}/${project.repoName}`}
              className="font-mono underline underline-offset-4"
              target="_blank"
              rel="noreferrer"
            >
              {project.repoOwner}/{project.repoName}
            </a>
          </p>
          <p>
            <span className="text-muted-foreground">Default branch:</span>{" "}
            <span className="font-mono">{project.defaultBranch}</span>
          </p>
        </CardContent>
      </Card>
    </section>
  );
}

/** Ingest tokens — BYO instances use these to ship run telemetry back to Eden. */
function IngestSection({
  loaderData,
  newToken,
}: {
  loaderData: Route.ComponentProps["loaderData"];
  newToken: string | null;
}) {
  const { tokens } = loaderData;
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";
  return (
    <section>
      <SectionHeader title="Run ingestion" />
      <p className="mb-3 text-sm text-muted-foreground">
        BYO instances ship telemetry to{" "}
        <span className="font-mono">/api/ingest/runs</span> with one of these
        tokens.
      </p>
      {newToken && (
        <Alert className="mb-4">
          <AlertTitle>New token — copy now, shown once</AlertTitle>
          <AlertDescription>
            <code className="font-mono">{newToken}</code>
          </AlertDescription>
        </Alert>
      )}
      {tokens.length > 0 && (
        <ul className="mb-4 space-y-1 text-sm text-muted-foreground">
          {tokens.map((t) => (
            <li key={t.id}>
              {t.name} · created {new Date(t.createdAt).toLocaleDateString()}
              {t.lastUsedAt
                ? ` · last used ${new Date(t.lastUsedAt).toLocaleDateString()}`
                : " · never used"}
            </li>
          ))}
        </ul>
      )}
      <Form method="post" className="flex items-center gap-2">
        <input type="hidden" name="intent" value="create-token" />
        <Input
          name="name"
          placeholder="production instance"
          className="max-w-xs"
        />
        <Button type="submit" disabled={busy}>
          Create ingest token
        </Button>
      </Form>
    </section>
  );
}

/** Destructive actions, deliberately last and deliberately loud. */
function DangerSection({
  project,
  activeAgent,
  canRemoveMember,
  showRepo,
  isTeam,
}: {
  project: { id: string; name: string };
  activeAgent: string;
  canRemoveMember: boolean;
  showRepo: boolean;
  isTeam: boolean;
}) {
  const submit = useSubmit();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  return (
    <section>
      <SectionHeader title="Danger zone" />
      <Card className="border-destructive/40">
        <CardContent className="divide-y py-0">
          {canRemoveMember && (
            <div className="flex flex-wrap items-center justify-between gap-3 py-4">
              <div>
                <p className="text-sm font-medium">
                  Remove {activeAgent} from the team
                </p>
                <p className="text-sm text-muted-foreground">
                  Opens a change request deleting{" "}
                  <span className="font-mono">agents/{activeAgent}/</span>.
                  Nothing is removed until it merges, and git can restore it
                  after.
                </p>
              </div>
              <ConfirmDialog
                trigger={
                  <Button variant="outline" disabled={busy}>
                    Remove member
                  </Button>
                }
                title={`Remove ${activeAgent} from the team?`}
                description={`Opens a change request deleting agents/${activeAgent}/. Nothing is removed until it merges, and git can restore it after.`}
                confirmLabel="Open change request"
                onConfirm={() =>
                  submit(
                    { intent: "remove-member", name: activeAgent },
                    { method: "post" },
                  )
                }
              />
            </div>
          )}
          {showRepo && (
            <div className="flex flex-wrap items-center justify-between gap-3 py-4">
              <div>
                <p className="text-sm font-medium">
                  Delete this repository from Eden
                </p>
                <p className="text-sm text-muted-foreground">
                  Stops and destroys every running instance, then permanently
                  deletes {isTeam ? "all members' " : "the agent's "}
                  versions, environments, secrets, drafts, and run history from
                  Eden. The GitHub repository itself is not touched.
                </p>
              </div>
              <DeleteRepositoryDialog projectName={project.name} busy={busy} />
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

/** Typed-name confirm for the full teardown — the one action that can't be undone. */
function DeleteRepositoryDialog({
  projectName,
  busy,
}: {
  projectName: string;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const submit = useSubmit();
  const confirm = () => {
    if (typed !== projectName) return;
    submit({ intent: "delete-repository", confirm: typed }, { method: "post" });
    setOpen(false);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setTyped("");
      }}
    >
      <DialogTrigger asChild>
        <Button variant="destructive" disabled={busy}>
          Delete repository
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            Delete &ldquo;{projectName}&rdquo; from Eden?
          </DialogTitle>
          <DialogDescription>
            This stops everything that&rsquo;s running and permanently deletes
            all Eden data for this repository — versions, environments, secrets,
            drafts, run history. It cannot be undone. The GitHub repository
            itself is not touched.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="delete-repo-confirm">
            Type <span className="font-mono font-semibold">{projectName}</span>{" "}
            to confirm
          </Label>
          <Input
            id="delete-repo-confirm"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={projectName}
            autoComplete="off"
            autoFocus
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={typed !== projectName}
            onClick={confirm}
          >
            Delete repository
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
