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
import { Boxes, Download, KeyRound, Layers, Plug } from "lucide-react";
import { useState } from "react";
import {
  Form,
  Link,
  data,
  redirect,
  useNavigate,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { COPY } from "~/components/secrets-card";

import {
  TYPE_META,
  TypeBadge,
} from "~/components/marketplace-type-badge";
import { AppShell, PageHeader, accentText } from "~/components/shell";
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
import { ensureWorkspace } from "~/auth/workspace.server";
import type { Agent } from "~/data/ports";
import { stageDeletions, stageDraft, listDrafts } from "~/drafts/drafts.server";
import { ZOD_PACKAGE, ZOD_VERSION } from "~/eve/agentModule";
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
import {
  resolveTemplate,
  type ResolvedAuth,
  type ResolvedInclude,
} from "~/marketplace/compose.server";
import { getGoogleOAuthConfig } from "~/connections/config.server";
import { missingScopes } from "~/connections/google.server";
import { findGrant } from "~/connections/grants.server";
import {
  findAppCredentialConflict,
  listAppCredentialRows,
} from "~/github/app-manifest.server";
import {
  planInstallSecretOps,
  writePendingSecret,
  type InstallSecretOp,
} from "~/project/secrets.server";
import { listSharedSecrets, setAttachment } from "~/seams/oss/secret-store";
import { decodeKey, fingerprint, seal } from "~/seams/oss/secretbox";
import {
  TEMPLATE_TYPES,
  isTemplateSlug,
  type TemplateManifest,
  type TemplateType,
} from "~/marketplace/manifest";
import { listProjects } from "~/db/queries.server";
import { resolveSyncedAgentContext } from "~/project/agent-context.server";
import { requireProject, requireRepo } from "~/project/guard.server";
import { getRuntime } from "~/seams/index.server";
import type { Route } from "./+types/marketplace.$type.$id.install";

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

/**
 * One brokered connection the wizard's Connect step renders (issue #30). `configured` is whether
 * the operator set up the provider's OAuth client; `grant` is the current app-scoped grant for the
 * chosen agent (null = not connected yet). `scopes` is space-separated for the connect URL.
 */
interface ConnectAuth {
  provider: string;
  scopes: string;
  configured: boolean;
  grant: { accountEmail: string | null; status: string } | null;
  /**
   * Whether an ACTIVE grant actually covers every scope this connector needs (issue #30). An active
   * grant made for a narrower connector — or an under-scoped grant from before granular-consent was
   * validated — would show "Connected" yet 403 at runtime; `covers=false` forces a Reconnect.
   */
  covers: boolean;
}

/** Whether a provider's OAuth client is configured on this control plane. Only Google in Phase 1. */
function providerConfigured(provider: string): boolean {
  return provider === "google" ? getGoogleOAuthConfig() !== null : false;
}

/**
 * Build the Connect-step payload for a chosen member install: one entry per resolved auth
 * descriptor, each with its current grant (looked up by the target agent's id) and whether the
 * provider is configured. `agentId` null (new-member/agent template — no agent row yet) yields
 * grant=null for every descriptor, so the step shows Connect buttons but never blocks.
 */
async function buildConnectAuths(
  auths: ResolvedAuth[],
  projectId: string,
  agentId: string | null,
): Promise<ConnectAuth[]> {
  return Promise.all(
    auths.map(async (a) => {
      const grant =
        agentId !== null
          ? await findGrant({ projectId, agentId, provider: a.provider })
          : null;
      const descriptorScopes = a.scopes.join(" ");
      // Coverage: an active grant only counts if its stored scopes include every scope this
      // connector declares (issue #30). Reuse the same pure scope-set helper as the callback.
      const covers =
        grant?.status === "active" &&
        missingScopes(descriptorScopes, grant.scopes).length === 0;
      return {
        provider: a.provider,
        scopes: descriptorScopes,
        configured: providerConfigured(a.provider),
        grant: grant
          ? { accountEmail: grant.accountEmail, status: grant.status }
          : null,
        covers,
      };
    }),
  );
}

interface PreviewData {
  files: string[];
  deletions: string[];
  conflicts: string[];
  warnings: string[];
  deps: DependencyDecision[];
  secrets: Array<{
    name: string;
    description?: string;
    sandbox?: boolean;
    provisioned?: boolean;
  }>;
  isUpdate: boolean;
  /** Templates bundled by reference (composition) — rendered as a "Bundled from the catalog" card. */
  includes: ResolvedInclude[];
}

export const loader = (args: LoaderFunctionArgs) =>
  authkitLoader(
    args,
    async ({ auth }) => {
      const type = parseType(args.params.type);
      const id = args.params.id!;
      if (!isTemplateSlug(id)) throw data("Unknown template", { status: 404 });
      await ensureWorkspace(args.request, auth);
      const { org } = await syncTenant(auth);

      // Resolve composition (includes) up front: the plan, the file preview, the dep/secret
      // merge — everything downstream operates on the flattened template, exactly as it installs.
      let template;
      try {
        template = await resolveTemplate(getRuntime().catalog, type, id);
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
        /** Project-level shared secret names — powers the three-way choice (§9). */
        sharedNames: [] as string[],
        /** Brokered connections to authorize before install (issue #30) — populated once a target is chosen. */
        connectAuths: [] as ConnectAuth[],
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
      const [source, drafts] = await Promise.all([
        getAgentSource(project.repoInstallationId, repo),
        listDrafts(project.id),
      ]);
      const ctx = await resolveSyncedAgentContext(project.id, null, source.paths);
      base.projectName = project.name;
      base.isTeam = ctx.isTeam;
      base.roster = ctx.roster.map((a) => ({ name: a.name }));
      if ((template.manifest.secrets?.length ?? 0) > 0) {
        try {
          base.sharedNames = [
            ...new Set((await listSharedSecrets(project.id)).map((s) => s.key)),
          ];
        } catch {
          base.sharedNames = []; // secrets store unavailable — the step degrades to value/skip
        }
      }

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
            { eve: "latest", [ZOD_PACKAGE]: ZOD_VERSION },
            template.manifest.dependencies,
          ),
          secrets: plan.secrets,
          isUpdate: plan.isUpdate,
          includes: template.includes,
        };
        // New-member install: no agent row yet, so grants can't be captured here — surface the
        // descriptors (Connect buttons) but never block; the Deployment tab handles it post-ship.
        base.connectAuths = await buildConnectAuths(template.auths, project.id, null);
        return base;
      }

      // Tool/skill/subagent → into an existing member.
      const resolved = resolveMemberTarget(ctx.roster, ctx.isTeam, selectedMember);
      if (!resolved) return base;
      base.connectAuths = await buildConnectAuths(
        template.auths,
        project.id,
        resolved.agent.id,
      );

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
        includes: template.includes,
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
    // ACTIONS read raw — a stale read composed into a write could clobber newer content. The
    // resolver re-flattens composition server-side by construction (never trusting the preview).
    const [template, source, drafts] = await Promise.all([
      resolveTemplate(getRuntime().catalog, type, id),
      fetchAgentSource(project.repoInstallationId, repo),
      listDrafts(project.id),
    ]);
    const ctx = await resolveSyncedAgentContext(project.id, null, source.paths);
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

    // Connections gate (issue #30): a member install must have an active grant for every brokered
    // auth descriptor before anything is staged (same short-circuit style as conflicts). A
    // new-member install can't capture a grant yet (no agent row) — it proceeds and reconnects
    // later from the Deployment tab.
    if (secretAgent && template.auths.length > 0) {
      for (const auth of template.auths) {
        if (!providerConfigured(auth.provider)) {
          return {
            error:
              `This Eden installation has no ${auth.provider} OAuth client configured — an ` +
              "operator must set the provider credentials on the control plane before this " +
              "connector can be installed.",
          };
        }
        const grant = await findGrant({
          projectId: project.id,
          agentId: secretAgent.id,
          provider: auth.provider,
        });
        if (!grant || grant.status !== "active") {
          return {
            error: `Connect ${providerLabel(auth.provider)} for this agent before installing — use the Connect button on the install page.`,
          };
        }
        // Scope coverage (issue #30): an active grant whose stored scopes don't cover this
        // connector's descriptor (a narrower connector, or a pre-granular-consent grant) would ship
        // a token that 403s at runtime. Refuse staging until the user reconnects with full scopes.
        if (missingScopes(auth.scopes.join(" "), grant.scopes).length > 0) {
          return {
            error: `Reconnect ${providerLabel(auth.provider)} for this agent — the current connection is missing permissions this connector needs.`,
          };
        }
      }
    }

    // Secrets are PLANNED before anything is staged so a refused install stages nothing.
    let secretOps: InstallSecretOp[] = [];
    if ((template.manifest.secrets?.length ?? 0) > 0) {
      let sharedNames: string[] = [];
      try {
        sharedNames = (await listSharedSecrets(project.id)).map((s) => s.key);
      } catch {
        sharedNames = [];
      }
      secretOps = planInstallSecretOps({
        secrets: template.manifest.secrets ?? [],
        form,
        sharedNames,
      });

      // Issue #26: a GitHub App is an agent's @mention identity — two agents in one project
      // sharing a slug/App ID is ambiguous (one webhook URL per App). The manifest flow can't
      // produce this, but the manual fallback lets the same credentials be pasted twice.
      const setValue = (name: string) => {
        const op = secretOps.find((o) => o.kind === "set" && o.name === name);
        return op?.kind === "set" ? op.value : undefined;
      };
      const slug = setValue("GITHUB_APP_SLUG");
      const appId = setValue("GITHUB_APP_ID");
      if (slug || appId) {
        const conflict = findAppCredentialConflict(
          await listAppCredentialRows(project.id),
          secretAgent?.id ?? null,
          { slug, appId },
        );
        if (conflict) {
          return {
            error:
              `Another agent in this project ("${conflict.agentName}") already uses this GitHub App ` +
              `(${conflict.key} matches). Every agent needs its own GitHub App — create one for this ` +
              "agent with the guided flow on its Deployment tab, or paste different credentials.",
          };
        }
      }
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

    // Secrets step (§9): one enabled step for every template kind. The pure planner decided
    // each secret's fate from the form above (shared-attach / value / skip); values never
    // persist anywhere but the sealed stores.
    if (secretOps.length > 0) {
      const ops = secretOps;
      if (secretAgent) {
        // Member install: the agent row exists — write agent-wide values (sandbox set
        // atomically) and attachment rows directly.
        const secrets = getRuntime().secrets;
        for (const op of ops) {
          if (op.kind === "set") {
            await secrets.set(
              {
                projectId: project.id,
                agentId: secretAgent.id,
                environmentId: null,
                key: op.name,
              },
              op.value,
              { sandboxExposed: op.sandbox, updatedBy: auth.user.id },
            );
          } else if (op.kind === "attach") {
            await setAttachment({
              projectId: project.id,
              agentId: secretAgent.id,
              key: op.name,
              attached: true,
              sandboxExposed: op.sandbox,
              createdBy: auth.user.id,
            });
          }
        }
      } else if (target.kind === "new-member") {
        // New-member install (§4.4): no agent row until the member ships — hold values
        // SEALED in pending_secrets and record shared-attach choices; the ship-time roster
        // sync migrates them, and abandonment cleanup discards them.
        const hasWork = ops.some((op) => op.kind !== "skip");
        if (hasWork) {
          const key = decodeKey(process.env.EDEN_SECRETS_KEY);
          for (const op of ops) {
            if (op.kind === "set") {
              await writePendingSecret({
                projectId: project.id,
                memberName: target.name,
                key: op.name,
                sealed: seal(key, op.value),
                fingerprint: fingerprint(op.value),
                sandboxExposed: op.sandbox,
                attachShared: false,
                createdBy: auth.user.id,
              });
            } else if (op.kind === "attach") {
              await writePendingSecret({
                projectId: project.id,
                memberName: target.name,
                key: op.name,
                sealed: { ciphertext: "", iv: "", authTag: "" },
                fingerprint: null,
                sandboxExposed: op.sandbox,
                attachShared: true,
                createdBy: auth.user.id,
              });
            }
          }
        }
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
  return [{ title: "Install · Marketplace · eden" }];
}

export default function InstallWizard({ loaderData, actionData }: Route.ComponentProps) {
  const {
    user,
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
    sharedNames,
    connectAuths,
  } = loaderData;
  const navigate = useNavigate();

  const backTo = `/marketplace/${type}/${manifest.id}`;
  const hasConflicts = (preview?.conflicts.length ?? 0) > 0;
  // Member installs must connect every configured brokered provider before staging (issue #30);
  // new-member installs can't (no agent row yet) so they never block on this. An active grant that
  // doesn't COVER the connector's scopes (covers=false) blocks too — it would 403 at runtime.
  const missingConnect =
    !newMemberTemplate &&
    connectAuths.some((a) => a.configured && !a.covers);
  // The current wizard URL — where a Connect round-trip returns to (relative, same-origin).
  const wizardReturnTo = (() => {
    const p = new URLSearchParams();
    if (selectedProjectId) p.set("project", selectedProjectId);
    if (selectedMember) p.set("member", selectedMember);
    if (newMemberName) p.set("newMember", newMemberName);
    return `/marketplace/${type}/${manifest.id}/install?${p.toString()}`;
  })();
  // Issue #47: provisioned secrets are set by a guided Eden flow (e.g. Create GitHub App on the
  // Deployment tab) — the wizard never collects them. Only the user-supplied ones get inputs; the
  // provisioned ones get a single muted note so the user isn't led to think they must provide them.
  const userSecrets = (preview?.secrets ?? []).filter((s) => !s.provisioned);
  const provisionedSecrets = (preview?.secrets ?? []).filter(
    (s) => s.provisioned,
  );
  const targetChosen = newMemberTemplate ? !!newMemberName : !!selectedMember;
  const canSubmit =
    !!selectedProjectId &&
    targetChosen &&
    !hasConflicts &&
    !singleAgentInvalid &&
    !missingConnect;
  // When the sole block is an unconnected provider, name it under the disabled button so the
  // Connect step above reads as the next action rather than a dead end.
  const unconnectedProvider = missingConnect
    ? connectAuths.find((a) => a.configured && !a.covers)?.provider
    : undefined;

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
    <AppShell userEmail={user.email}>
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
        icon={TYPE_META[manifest.type].icon}
        accent={TYPE_META[manifest.type].accent}
        title={
          <span className="flex items-center gap-3">
            Install {manifest.name}
            <TypeBadge type={manifest.type} />
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
            <CardTitle className="flex items-center gap-2 text-base">
              <Boxes className={`size-4 ${accentText.cyan}`} aria-hidden />
              Target
            </CardTitle>
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

        {/* 2 — Composition (only when the template bundles others by reference) */}
        {preview && preview.includes.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Layers className={`size-4 ${accentText.indigo}`} aria-hidden />
                Bundled from the catalog
              </CardTitle>
              <CardDescription>
                These templates are materialized into the target agent as part of
                this install — you don&rsquo;t install them separately.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2 text-sm">
                {preview.includes.map((inc) => (
                  <li
                    key={`${inc.type}/${inc.id}`}
                    className="flex items-center gap-2"
                  >
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {inc.name}
                    </span>
                    <span className="font-mono text-xs text-muted-foreground">
                      v{inc.version}
                    </span>
                    <TypeBadge type={inc.type} />
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}

        {/* 3 — What this installs */}
        {preview && (
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Download className={`size-4 ${accentText.emerald}`} aria-hidden />
                  What this installs
                </CardTitle>
                {preview.isUpdate && <Badge variant="warning">update</Badge>}
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
                    <li
                      key={f}
                      className="flex items-center gap-2 px-3 py-1.5 font-mono text-xs"
                    >
                      <span
                        className="text-emerald-600 dark:text-emerald-400"
                        aria-hidden
                      >
                        +
                      </span>
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
                        className="flex items-center gap-2 px-3 py-1.5 font-mono text-xs"
                      >
                        <span className="text-rose-600 dark:text-rose-400" aria-hidden>
                          −
                        </span>
                        <span className="line-through decoration-destructive/60">
                          {f}
                        </span>
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

        {/* 3.5 — Connect (brokered OAuth connections, issue #30) */}
        {preview && connectAuths.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Plug className={`size-4 ${accentText.cyan}`} aria-hidden />
                Connect
              </CardTitle>
              <CardDescription>
                This connector authorizes against your account. Connect it before
                installing so the agent can act on your behalf.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {connectAuths.map((auth) => (
                <ConnectAuthRow
                  key={auth.provider}
                  auth={auth}
                  agentName={selectedMember}
                  isNewMember={newMemberTemplate}
                  returnTo={wizardReturnTo}
                  projectId={selectedProjectId}
                />
              ))}
            </CardContent>
          </Card>
        )}

        {/* 4 — Secrets + submit */}
        {preview && (
          <Form method="post">
            <input type="hidden" name="intent" value="install" />
            <input type="hidden" name="project" value={selectedProjectId ?? ""} />
            {newMemberTemplate ? (
              <input type="hidden" name="newMember" value={newMemberName ?? ""} />
            ) : (
              <input type="hidden" name="member" value={selectedMember ?? ""} />
            )}

            {/* Issue #47: gate on userSecrets, not preview.secrets — a template whose secrets are
                all provisioned (e.g. the GitHub channel) shows no Secrets card at all. */}
            {userSecrets.length > 0 && (
              <Card className="mb-6">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <KeyRound className={`size-4 ${accentText.amber}`} aria-hidden />
                    Secrets
                  </CardTitle>
                  <CardDescription>
                    {newMemberTemplate
                      ? `This agent needs ${userSecrets.length} secret${userSecrets.length === 1 ? "" : "s"}. Enter them now — they'll be attached when the member ships. Values are encrypted write-only.`
                      : "Stored per-agent, agent-wide. Values are encrypted write-only. Leave blank to set later in Settings."}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-5">
                  {userSecrets.map((s) => (
                    <InstallSecretField
                      key={s.name}
                      secret={s}
                      sharedExists={sharedNames.includes(s.name)}
                    />
                  ))}
                  {newMemberTemplate && userSecrets.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      {COPY.installDeferral}
                    </p>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Issue #47: provisioned secrets are set by guided setup, not entered here — a single
                muted line, no card and no key icon, so they read as informational, not a to-do. */}
            {provisionedSecrets.length > 0 && (
              <p className="mb-6 text-xs text-muted-foreground">
                <span className="font-mono">
                  {provisionedSecrets.map((s) => s.name).join(", ")}
                </span>{" "}
                are set automatically during guided setup on the agent&rsquo;s
                Deployment tab after install — nothing to enter here.
              </p>
            )}

            <div className="flex items-center gap-3">
              <Button type="submit" disabled={!canSubmit}>
                Stage install
              </Button>
              <span className="text-sm text-muted-foreground">
                {unconnectedProvider
                  ? `Connect ${providerLabel(unconnectedProvider)} above before installing.`
                  : "Stages a change-set — review and publish it on the Deployment tab."}
              </span>
            </div>
          </Form>
        )}
      </div>
    </AppShell>
  );
}

/**
 * One manifest secret in the install step (§9): a three-way choice when a project-level shared
 * secret with the same name exists (use shared — the default, prevents token sprawl / enter a
 * value / skip), or a value input with a Skip affordance otherwise. Emits hidden fields the
 * action's planInstallSecretOps reads: `secretmode:<name>`, `secret:<name>`,
 * `secretsandbox:<name>`. Sandbox is pre-checked from the manifest and always editable.
 */
function InstallSecretField({
  secret,
  sharedExists,
}: {
  secret: { name: string; description?: string; sandbox?: boolean };
  sharedExists: boolean;
}) {
  const [mode, setMode] = useState<"shared" | "value" | "skip">(
    sharedExists ? "shared" : "value",
  );
  const [value, setValue] = useState("");
  const [sandbox, setSandbox] = useState(secret.sandbox ?? false);

  return (
    <div className="grid max-w-md gap-1.5">
      <Label className="font-mono text-xs">{secret.name}</Label>
      {secret.description && (
        <p className="text-xs text-muted-foreground">{secret.description}</p>
      )}
      <input type="hidden" name={`secretmode:${secret.name}`} value={mode} />
      <input
        type="hidden"
        name={`secretsandbox:${secret.name}`}
        value={sandbox ? "1" : "0"}
      />

      {sharedExists ? (
        <div className="space-y-1.5">
          <Label className="flex items-center gap-2 text-sm font-normal">
            <input
              type="radio"
              name={`secretchoice:${secret.name}`}
              checked={mode === "shared"}
              onChange={() => setMode("shared")}
            />
            Use project-level {secret.name} (recommended)
          </Label>
          <Label className="flex items-center gap-2 text-sm font-normal">
            <input
              type="radio"
              name={`secretchoice:${secret.name}`}
              checked={mode === "value"}
              onChange={() => setMode("value")}
            />
            Enter a value for this agent
          </Label>
          {mode === "value" && (
            <Input
              name={`secret:${secret.name}`}
              type="password"
              autoComplete="off"
              placeholder="value (write-only)"
              className="ml-6 w-full font-mono sm:w-72"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          )}
          <Label className="flex items-center gap-2 text-sm font-normal">
            <input
              type="radio"
              name={`secretchoice:${secret.name}`}
              checked={mode === "skip"}
              onChange={() => setMode("skip")}
            />
            Skip — I&rsquo;ll add it later
          </Label>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Input
            name={`secret:${secret.name}`}
            type="password"
            autoComplete="off"
            placeholder="value (write-only)"
            className="w-full min-w-0 font-mono sm:w-72"
            value={mode === "skip" ? "" : value}
            disabled={mode === "skip"}
            onChange={(e) => setValue(e.target.value)}
          />
          <button
            type="button"
            className="text-xs text-muted-foreground underline-offset-4 hover:underline"
            onClick={() => setMode(mode === "skip" ? "value" : "skip")}
          >
            {mode === "skip" ? "Enter a value" : "Skip"}
          </button>
        </div>
      )}

      {mode !== "skip" && (
        <Label className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
          <input
            type="checkbox"
            checked={sandbox}
            onChange={(e) => setSandbox(e.target.checked)}
          />
          Expose to sandbox shell
          {secret.sandbox && <span>· Requested by template</span>}
        </Label>
      )}
    </div>
  );
}

/** Human label for a provider id (Phase 1: just Google). */
function providerLabel(provider: string): string {
  if (provider === "google") return "Google";
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

/**
 * One brokered connection in the Connect step (issue #30). Three states: not configured (a muted
 * operator note), connected (shows the account + a subtle Reconnect), or not-yet-connected (a
 * Connect button). A new-member install can't connect here — no agent row exists yet — so it shows
 * a deferral note instead.
 */
function ConnectAuthRow({
  auth,
  agentName,
  isNewMember,
  returnTo,
  projectId,
}: {
  auth: ConnectAuth;
  agentName: string | null;
  isNewMember: boolean;
  returnTo: string;
  projectId: string | null;
}) {
  const label = providerLabel(auth.provider);
  const upperEnv =
    auth.provider === "google"
      ? "EDEN_GOOGLE_CLIENT_ID / EDEN_GOOGLE_CLIENT_SECRET"
      : `${auth.provider.toUpperCase()} OAuth credentials`;

  if (!auth.configured) {
    return (
      <div className="grid gap-1">
        <Label className="text-sm font-medium">{label}</Label>
        <p className="text-xs text-muted-foreground">
          This Eden installation has no {label} OAuth client configured — an
          operator must set <span className="font-mono">{upperEnv}</span> on the
          control plane before this connector can be used.
        </p>
      </div>
    );
  }

  if (isNewMember || !agentName || !projectId) {
    return (
      <div className="grid gap-1">
        <Label className="text-sm font-medium">{label}</Label>
        <p className="text-xs text-muted-foreground">
          Connect {label} after this member ships — from its Deployment tab.
        </p>
      </div>
    );
  }

  const connectUrl =
    `/google/connect?project=${encodeURIComponent(projectId)}` +
    `&agent=${encodeURIComponent(agentName)}` +
    `&scopes=${encodeURIComponent(auth.scopes)}` +
    `&returnTo=${encodeURIComponent(returnTo)}`;
  const active = auth.grant?.status === "active";
  // Only a covered grant reads as "Connected" with the subtle Reconnect link (issue #30). An active
  // but under-scoped grant is a to-do, not a done: it 403s at runtime, so it gets the primary
  // Reconnect button and the "missing permissions" copy — a reconnect (include_granted_scopes) fixes it.

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="grid gap-0.5">
        <Label className="text-sm font-medium">{label}</Label>
        {active && auth.covers ? (
          <p className="text-xs text-muted-foreground">
            Connected as{" "}
            <span className="font-medium text-foreground">
              {auth.grant?.accountEmail ?? "your Google account"}
            </span>
          </p>
        ) : active ? (
          <p className="text-xs text-muted-foreground">
            Connected as{" "}
            <span className="font-medium text-foreground">
              {auth.grant?.accountEmail ?? "your Google account"}
            </span>{" "}
            — missing permissions this connector needs.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {auth.grant
              ? `Connection ${auth.grant.status} — reconnect to continue.`
              : `Authorize ${label} so the agent can act on your behalf.`}
          </p>
        )}
      </div>
      {active && auth.covers ? (
        <a
          href={connectUrl}
          className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          Reconnect
        </a>
      ) : (
        <Button asChild variant="default" size="sm">
          <a href={connectUrl}>{active ? "Reconnect" : `Connect ${label}`}</a>
        </Button>
      )}
    </div>
  );
}

function DepBadge({ status }: { status: DependencyDecision["status"] }) {
  if (status === "add") return <Badge variant="success">add</Badge>;
  if (status === "keep") return <Badge variant="outline">already present</Badge>;
  return <Badge variant="destructive">range conflict</Badge>;
}
