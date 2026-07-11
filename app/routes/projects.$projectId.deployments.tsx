/**
 * Deployment — the whole pipeline on one tab (M5.8; Deploy + Review pillars, PRD §7.3/§7.4/§7.7).
 *
 * SHIP makes versions (Overview); this tab is everything after an edit exists:
 *   staged changes → change request → merge (cuts a version) → environments running versions.
 *
 * The TEAM is the deployment unit. Deploys ACT on an ENVIRONMENT and move the whole roster; the
 * only question a user answers is "which environment", never "which agent". Env CRUD and
 * deploy-a-version are therefore team-level. Skew across environments is fine (staging ahead of
 * prod); skew WITHIN an environment is eliminated.
 *
 * Two layouts over one module (route ids `deployment` + `member-deployment`), gated by a `canAct`
 * flag = the team-level acting surface:
 *  - REPO / TEAM view (team repos at /repos/:id/deployment): the acting surface — staged drafts
 *    grouped by member, change requests + Merge, an Environments card (one row per team env NAME
 *    with each member's running version) with team CRUD, and a Version history of TEAM versions
 *    (grouped by commit) with a per-environment Deploy that moves the whole team.
 *  - MEMBER view (team members at /repos/:id/agents/:name/deployment): OBSERVE-only for deploy
 *    concerns — the member's running versions and version history, no deploy/CRUD buttons (staged
 *    changes + change requests stay actionable everywhere; they're edit flow, not deploy flow).
 *  - SINGLE (single-agent repos at /repos/:id/deployment, level 'single'): a team of one, so it
 *    renders the member layout with canAct=true — the same team-scoped intents, roster of one.
 */
import { getSessionAuth, sessionLoader } from "~/auth/session.server";
import {
  FileStack,
  GitPullRequest,
  History,
  MessageSquare,
  Rocket,
  Server,
  Webhook,
  type LucideIcon,
} from "lucide-react";
import { useRef, useState } from "react";
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

import { ConfirmDialog } from "~/components/confirm-dialog";
import { EmptyTeamState } from "~/components/empty-team-state";
import {
  FreshnessBadge,
  releaseFreshness,
} from "~/components/deploy-freshness";
import {
  AgentNav,
  AppShell,
  PageHeader,
  accentChip,
  repoCrumbs,
  type Accent,
  type NavLevel,
} from "~/components/shell";
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
  createTeamEnvironment,
  deleteTeamEnvironment,
  listTeamEnvNames,
  renameTeamEnvironment,
} from "~/deploy/environments.server";
import { deployTeamVersion } from "~/deploy/ship.server";
import {
  listAgentEnvironments,
  listEnvironments,
  listReleases,
  syncProjectAgents,
} from "~/db/queries.server";
import {
  discardDrafts,
  findOrphanedDrafts,
  listDrafts,
  publishDrafts,
} from "~/drafts/drafts.server";
import {
  getAgentSource,
  getOpenChanges,
  invalidateRepoSource,
  warmAgentSource,
} from "~/github/cached.server";
import {
  findStoredAppCredentialConflict,
  listAppCredentialRows,
  listAppInstallations,
  type AppInstallation,
} from "~/github/app-manifest.server";
import { fetchAgentSource } from "~/github/repo.server";
import { closePullRequest, mergePullRequest } from "~/github/write.server";
import { getDiscordAppConfig } from "~/discord/config.server";
import { listConnectionsForAgent } from "~/discord/connections.server";
import { getGoogleOAuthConfig } from "~/connections/config.server";
import {
  connectionRowState,
  type ConnectionRowState,
} from "~/connections/google.server";
import { listGrantsForAgent } from "~/connections/grants.server";
import {
  discardConversationCheckoutByBranch,
  isConversationBranch,
} from "~/assistant/checkout-sync.server";
import { getRuntime } from "~/seams/index.server";
import { ensureWorkerStarted } from "~/jobs/worker.server";
import { contextPath } from "~/lib/paths";
import { useLiveRevalidate } from "~/lib/use-live-revalidate";
import { cn } from "~/lib/utils";
import { overlayLock, requiredScopesByProvider } from "~/marketplace/lock";
import {
  agentRequiredSecretState,
  cleanupOrphanedPendingSecrets,
} from "~/project/secrets.server";
import { listAgents } from "~/db/queries.server";
import { listSharedSecrets } from "~/seams/oss/secret-store";
import {
  DeploySecretsGuardDialog,
  type GuardMissingSecret,
} from "~/components/deploy-secrets-guard";
import { RelativeTime } from "~/components/localized-values";
import {
  agentFromParams,
  agentParamRedirect,
  memberFromPath,
  requireActiveAgent,
  resolveSyncedAgentContext,
} from "~/project/agent-context.server";
import { detectAgentRoots, hasTeamLayout } from "~/eve/parse";
import { requireProject, requireRepo } from "~/project/guard.server";
import type {
  DeploymentWithRelease,
  DraftChange,
  Environment,
  Release,
} from "~/data/ports";
import type { ConnectedProject } from "~/project/guard.server";
import type { OpenChange } from "~/github/write.server";
import { DiffView } from "~/components/diff-view";
import type { Route } from "./+types/projects.$projectId.deployments";

/** One member's cell inside a team environment row: its env id + what's running there. */
interface TeamEnvMember {
  name: string;
  envId: string | null;
  deployments: DeploymentWithRelease[];
}
/** A team environment: one NAME, every member's row of that name. */
interface TeamEnvRow {
  name: string;
  members: TeamEnvMember[];
}
/** A team version: releases at one commit, across members (newest first). */
interface TeamVersionRow {
  gitSha: string;
  /** The first member's release version in the group (labels can differ per member). */
  version: string;
  changelog: string | null;
  createdAt: Date;
  /** Team env names currently running this version (any member's live deploy). */
  runningEnvNames: string[];
}

/** One shape for both layouts so the loader's branches unify (unused fields empty per branch). */
interface DeploymentData {
  project: ConnectedProject;
  roster: { name: string }[];
  activeAgent: string;
  isTeam: boolean;
  level: NavLevel;
  view: "repo" | "member";
  /** True where deploys/CRUD are acted on: the team (repo) view and single-agent repos. */
  canAct: boolean;
  drafts: (DraftChange & { shared: boolean; orphaned: boolean })[];
  changes: OpenChange[];
  releases: Release[];
  envs: { env: Environment; deployments: DeploymentWithRelease[] }[];
  draftGroups: { owner: string; drafts: (DraftChange & { orphaned: boolean })[] }[];
  members: {
    name: string;
    latest: { version: string; gitSha: string; createdAt: Date } | null;
  }[];
  /** Team (repo) view: the team's env names, oldest first (the first is the primary). */
  teamEnvNames: string[];
  /** Team (repo) view: one row per env name, each member's running status. */
  teamEnvs: TeamEnvRow[];
  /** Team (repo) view: version history grouped by commit, newest first. */
  teamVersions: TeamVersionRow[];
  /** Deploy guard (§9): unmet template-required secrets (member-tagged in the team aggregate). */
  missingSecrets: GuardMissingSecret[];
  /** Deploy guard: the member whose settings the guard links to fix secrets on. */
  guardAgent: string;
  guardSettingsAction: string;
  /** Member/single view: Discord connect state when the agent has the marketplace Discord channel. */
  discordSetup: {
    enabled: boolean;
    /** Whether the operator has configured Eden's shared Discord app (EDEN_DISCORD_*). */
    configured: boolean;
    /** Member view: the agent's connected servers; null in the team view (setup is per member). */
    connections: Array<{
      id: string;
      guildId: string;
      guildName: string | null;
      commandName: string;
      environmentId: string;
    }> | null;
  };
  /**
   * Member/single view: the connector rows for this agent (issue #30) — the UNION of every provider
   * the lock REQUIRES and every existing grant, so a freshly installed connector with no grant yet
   * still shows a Connect button. This card is now the ONE place a connector is connected/reconnected;
   * installs no longer gate on it. Empty in the team (hint-only) view.
   */
  connections: Array<{
    /** Grant id when connected, else a synthetic `provider:<name>` key for the lock-derived row. */
    id: string;
    provider: string;
    accountEmail: string | null;
    /** What Google GRANTED last time — a record only, never the Reconnect request template (§#30). */
    scopes: string;
    /** Grant status, or null when there's no grant yet (lock-derived row). */
    status: string | null;
    /**
     * The space-joined scopes a Connect/Reconnect must REQUEST for this provider, derived from the
     * install's lock snapshot (issue #30). Null when the lock carries no snapshot (old locks) — the
     * card then falls back to the stored grant `scopes`.
     */
    requiredScopes: string | null;
    /** Loader-computed row state — the server-only scope comparison stays out of the render path. */
    state: ConnectionRowState;
  }>;
  /** Whether the operator configured a Google OAuth client — gates the reconnect action. */
  connectionsConfigured: boolean;
  /** Member/single view: GitHub App setup when the agent has the marketplace GitHub channel. */
  githubSetup: {
    enabled: boolean;
    /** The agent's App slug (its @name) once created — links the card to GitHub's install picker. */
    appSlug: string | null;
    /** Where the App is installed (accounts + repo grants); null when it couldn't be fetched. */
    installations: AppInstallation[] | null;
  };
}

export const loader = (args: LoaderFunctionArgs) =>
  sessionLoader(
    args,
    async ({ auth }): Promise<DeploymentData> => {
      const project = requireRepo(
        await requireProject(auth, args.params.projectId, {
          request: args.request,
        }),
      );
      const agentName = agentFromParams(args.params);
      if (!agentName) {
        const legacy = agentParamRedirect(args.request, project.id);
        if (legacy) throw legacy;
      }
      const [allDrafts, changes, releaseRows, source] = await Promise.all([
        listDrafts(project.id),
        getOpenChanges(project.repoInstallationId, {
          owner: project.repoOwner,
          repo: project.repoName,
        }),
        listReleases(project.id),
        getAgentSource(project.repoInstallationId, {
          owner: project.repoOwner,
          repo: project.repoName,
        }),
      ]);
      const { roster, active, isTeam } = await resolveSyncedAgentContext(
        project.id,
        agentName,
        source.paths,
      );
      // Drafts stranded under a member root the roster/repo/selection no longer back (issue #67):
      // surfaced as orphaned (unchecked, discardable) and blocked at publish with attribution.
      const orphanedPaths = new Set(
        findOrphanedDrafts(roster, source.paths, allDrafts).map((d) => d.path),
      );
      const level: NavLevel = agentName ? "member" : isTeam ? "repo" : "single";
      const view = level === "repo" ? ("repo" as const) : ("member" as const);
      // The acting surface: the team (repo) view, and single-agent repos (a team of one).
      const canAct = level !== "member";

      if (view === "repo") {
        // Team acting surface: staged drafts grouped by member, plus the team's environments
        // (one NAME, every member's running status) and version history (grouped by commit).
        const nameById = new Map(roster.map((a) => [a.id, a.name]));
        const groups = new Map<string, typeof allDrafts>();
        for (const d of allDrafts) {
          const key = d.agentId
            ? (nameById.get(d.agentId) ?? memberFromPath(d.path) ?? "shared")
            : (memberFromPath(d.path) ?? "shared");
          groups.set(key, [...(groups.get(key) ?? []), d]);
        }
        const members = roster.map((a) => {
          const latest = releaseRows.find((r) => r.agentId === a.id);
          return {
            name: a.name,
            latest: latest
              ? {
                  version: latest.version,
                  gitSha: latest.gitSha,
                  createdAt: latest.createdAt,
                }
              : null,
          };
        });

        // Per member: its env rows joined to their deployments (reuse listDeployments).
        const teamEnvNames = await listTeamEnvNames(project.id);
        // One env query for the whole roster (grouped by agent) instead of one per
        // member — avoids N extra round-trips that grow with team size.
        const projectEnvs = await listEnvironments(project.id);
        const envsByAgent = new Map<string, typeof projectEnvs>();
        for (const env of projectEnvs) {
          envsByAgent.set(env.agentId, [
            ...(envsByAgent.get(env.agentId) ?? []),
            env,
          ]);
        }
        const perMember = await Promise.all(
          roster.map(async (a) => {
            const envRows = envsByAgent.get(a.id) ?? [];
            const envs = await Promise.all(
              envRows.map(async (env) => ({
                env,
                deployments: await listDeployments(env.id),
              })),
            );
            return { name: a.name, envs };
          }),
        );
        const teamEnvs: TeamEnvRow[] = teamEnvNames.map((name) => ({
          name,
          members: perMember.map((m) => {
            const match = m.envs.find((e) => e.env.name === name);
            return {
              name: m.name,
              envId: match?.env.id ?? null,
              deployments: match?.deployments ?? [],
            };
          }),
        }));
        // Which version each env is running (any member's live deploy), for version badges.
        const envRunningSha = new Map<string, string>();
        for (const te of teamEnvs) {
          for (const m of te.members) {
            const live = m.deployments.find((d) => d.status === "live");
            if (live) {
              envRunningSha.set(te.name, live.gitSha);
              break;
            }
          }
        }
        // Version history grouped by commit (releaseRows are newest-first; first per sha wins).
        const versionByCommit = new Map<string, TeamVersionRow>();
        for (const r of releaseRows) {
          if (versionByCommit.has(r.gitSha)) continue;
          versionByCommit.set(r.gitSha, {
            gitSha: r.gitSha,
            version: r.version,
            changelog: r.changelog,
            createdAt: r.createdAt,
            runningEnvNames: teamEnvNames.filter(
              (n) => envRunningSha.get(n) === r.gitSha,
            ),
          });
        }
        const teamVersions = [...versionByCommit.values()];

        // Deploy guard (§9), aggregated across members and member-tagged.
        let missingSecrets: GuardMissingSecret[] = [];
        try {
          const shared = await listSharedSecrets(project.id);
          const sharedNames = new Set(shared.map((s) => s.key));
          const lock = overlayLock(
            source.files["eden-lock.json"] ?? null,
            allDrafts.map((d) => ({ path: d.path, content: d.content })),
          );
          const perMemberSecrets = await Promise.all(
            roster.map(async (a) => {
              const state = await agentRequiredSecretState({
                projectId: project.id,
                agentId: a.id,
                memberName: a.name,
                isTeam,
                lock,
              });
              return state.missing.map((m) => ({
                ...m,
                sharedExists: sharedNames.has(m.name),
                member: a.name,
              }));
            }),
          );
          missingSecrets = perMemberSecrets.flat();
        } catch {
          missingSecrets = []; // secrets store unavailable — never block the pipeline view
        }
        const guardAgent = missingSecrets[0]?.member ?? roster[0]?.name ?? "";
        return {
          project,
          roster: roster.map((a) => ({ name: a.name })),
          activeAgent: active?.name ?? "",
          isTeam,
          level,
          view,
          canAct,
          draftGroups: [...groups.entries()].map(([owner, drafts]) => ({
            owner,
            drafts: drafts.map((d) => ({
              ...d,
              orphaned: orphanedPaths.has(d.path),
            })),
          })),
          changes,
          members,
          drafts: [],
          releases: [],
          envs: [],
          teamEnvNames,
          teamEnvs,
          teamVersions,
          missingSecrets,
          guardAgent,
          guardSettingsAction: `${contextPath(project.id, guardAgent)}/settings`,
          // Channel setup is per member — the team view has no setup cards.
          discordSetup: {
            enabled: false,
            configured: false,
            connections: null,
          },
          connections: [],
          connectionsConfigured: getGoogleOAuthConfig() !== null,
          githubSetup: {
            enabled: false,
            appSlug: null,
            installations: null,
          },
        };
      }

      // Member pipeline: this member's drafts + shared ones, its envs + versions.
      requireActiveAgent(active, project.id);
      const drafts = allDrafts.flatMap((d) =>
        d.agentId === active.id || d.agentId === null
          ? [{ ...d, shared: d.agentId === null, orphaned: orphanedPaths.has(d.path) }]
          : [],
      );
      const envRows = await listAgentEnvironments(active.id);
      const envs = await Promise.all(
        envRows.map(async (env) => ({
          env,
          deployments: await listDeployments(env.id),
        })),
      );
      // Deploy guard (§9): required-but-unset names for this member; dismissed never trigger.
      let missingSecrets: GuardMissingSecret[] = [];
      const activeHasChannelFile = (channel: string) =>
        source.paths.includes(`${active.root}/channels/${channel}.ts`) ||
        allDrafts.some(
          (d) =>
            d.content !== null &&
            d.path === `${active.root}/channels/${channel}.ts`,
        );
      let hasDiscordSetup = activeHasChannelFile("discord");
      let hasGithubSetup = activeHasChannelFile("github");
      // The effective lock for this agent (drafts overlaid) — drives both the missing-secret guard
      // and the Connections card's required-scope derivation (issue #30).
      const lock = overlayLock(
        source.files["eden-lock.json"] ?? null,
        allDrafts.map((d) => ({ path: d.path, content: d.content })),
      );
      // The lock attributes installs to a member name (team) or null (single-agent root) — mirror
      // lockSecretsForMember's mapping so the required-scope union covers the right installs.
      const activeMember = isTeam ? active.name : null;
      const requiredScopes = requiredScopesByProvider(lock, activeMember);
      try {
        const [state, shared] = await Promise.all([
          agentRequiredSecretState({
            projectId: project.id,
            agentId: active.id,
            memberName: active.name,
            isTeam,
            lock,
          }),
          listSharedSecrets(project.id),
        ]);
        const sharedNames = new Set(shared.map((s) => s.key));
        missingSecrets = state.missing.map((m) => ({
          ...m,
          sharedExists: sharedNames.has(m.name),
        }));
        if (state.all.some(isDiscordSecretRequirement)) {
          hasDiscordSetup = true;
        }
        if (state.all.some(isGitHubSecretRequirement)) {
          hasGithubSetup = true;
        }
      } catch {
        missingSecrets = []; // secrets store unavailable — never block the pipeline view
      }
      // The App's @name once the guided flow (or manual setup) stored it, plus where it's
      // installed — the setup card renders real state (accounts, repo grants) and guides
      // adding accounts, so the user never needs to know GitHub's install-page URL.
      // Discord: the servers this agent is connected to (issue #32) — the setup card lists them
      // and offers "Connect another server". Only when the operator configured the shared app.
      const discordConfigured = getDiscordAppConfig() !== null;
      let discordConnections: DeploymentData["discordSetup"]["connections"] =
        null;
      if (hasDiscordSetup && discordConfigured) {
        try {
          const rows = await listConnectionsForAgent(active.id);
          discordConnections = rows.map((c) => ({
            id: c.id,
            guildId: c.guildId,
            guildName: c.guildName,
            commandName: c.commandName,
            environmentId: c.environmentId,
          }));
        } catch {
          discordConnections = null; // store hiccup — the card falls back to the connect button
        }
      }
      // Connector rows for this agent (issue #30): the UNION of every provider the lock REQUIRES and
      // every existing grant. With the install wizard's connect gate gone, a freshly installed
      // connector has no grant yet — the lock-required provider still gets a row (Connect button), so
      // this card is the ONE place a connector is connected/reconnected.
      let connectionGrantRows: DeploymentData["connections"] = [];
      try {
        const grants = await listGrantsForAgent(active.id);
        const grantByProvider = new Map(grants.map((g) => [g.provider, g]));
        const providers = [
          ...new Set([...requiredScopes.keys(), ...grantByProvider.keys()]),
        ].sort();
        connectionGrantRows = providers.map((provider) => {
          const grant = grantByProvider.get(provider);
          const req = requiredScopes.get(provider);
          // The scopes a Connect/Reconnect must REQUEST, from the install's lock snapshot (issue #30).
          // Null when the lock has no snapshot for this provider (old locks) → the card falls back to
          // the grant's stored scopes.
          const requiredScopeStr = req && req.length > 0 ? req.join(" ") : null;
          return {
            id: grant?.id ?? `provider:${provider}`,
            provider,
            accountEmail: grant?.accountEmail ?? null,
            scopes: grant?.scopes ?? "",
            status: grant?.status ?? null,
            requiredScopes: requiredScopeStr,
            state: connectionRowState({
              hasGrant: grant !== undefined,
              grantStatus: grant?.status ?? null,
              requiredScopes: requiredScopeStr,
              grantScopes: grant?.scopes ?? "",
            }),
          };
        });
      } catch {
        connectionGrantRows = []; // store hiccup — the card simply doesn't render
      }
      let githubAppSlug: string | null = null;
      let githubInstallations: AppInstallation[] | null = null;
      if (hasGithubSetup) {
        const secretRef = (key: string) => ({
          projectId: project.id,
          agentId: active.id,
          environmentId: null,
          key,
        });
        try {
          githubAppSlug = await getRuntime().secrets.get(
            secretRef("GITHUB_APP_SLUG"),
          );
          if (githubAppSlug) {
            const [appId, privateKey] = await Promise.all([
              getRuntime().secrets.get(secretRef("GITHUB_APP_ID")),
              getRuntime().secrets.get(secretRef("GITHUB_APP_PRIVATE_KEY")),
            ]);
            if (appId && privateKey) {
              githubInstallations = await listAppInstallations({
                appId,
                privateKey,
              });
            }
          }
        } catch {
          githubInstallations = null; // GitHub/secrets hiccup — the card falls back to a link
        }
      }
      return {
        project,
        roster: roster.map((a) => ({ name: a.name })),
        activeAgent: active.name,
        isTeam,
        level,
        view,
        canAct,
        drafts,
        changes,
        releases: releaseRows.filter((r) => r.agentId === active.id),
        envs,
        draftGroups: [],
        members: [],
        teamEnvNames: [],
        teamEnvs: [],
        teamVersions: [],
        missingSecrets,
        guardAgent: active.name,
        guardSettingsAction: `${contextPath(
          project.id,
          level === "member" ? active.name : null,
        )}/settings`,
        discordSetup: {
          enabled: hasDiscordSetup,
          configured: discordConfigured,
          connections: discordConnections,
        },
        connections: connectionGrantRows,
        connectionsConfigured: getGoogleOAuthConfig() !== null,
        githubSetup: {
          enabled: hasGithubSetup,
          appSlug: githubAppSlug,
          installations: githubInstallations,
        },
      };
    },
    { ensureSignedIn: true },
  );

/** §4.4 abandonment sweep: drop held pending secrets whose install can no longer ship. */
async function sweepPendingSecrets(projectId: string): Promise<void> {
  try {
    const [roster, drafts] = await Promise.all([
      listAgents(projectId),
      listDrafts(projectId),
    ]);
    await cleanupOrphanedPendingSecrets({
      projectId,
      rosterNames: roster.map((a) => a.name),
      draftPaths: drafts.map((d) => d.path),
    });
  } catch (error) {
    console.warn("[secrets] pending-secret sweep failed:", error);
  }
}

export async function action(args: ActionFunctionArgs) {
  const auth = await getSessionAuth(args);
  if (!auth.user) throw redirect("/login");
  const project = requireRepo(
    await requireProject(auth, args.params.projectId),
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
      // Install abandonment (§4.4): a discarded new-member install can leave held pending
      // secrets orphaned — sweep names with no roster row and no remaining member drafts.
      await sweepPendingSecrets(project.id);
      throw redirect(back);
    }
    if (intent === "delete-change") {
      const pullNumber = Number(form.get("pullNumber"));
      const branch = String(form.get("branch") ?? "") || undefined;
      if (!pullNumber) return { error: "Missing change to delete." };
      await closePullRequest(
        project.repoInstallationId,
        repo,
        pullNumber,
        branch,
      );
      // An assistant conversation branch is discarded with its PR — drop the checkout link row.
      if (isConversationBranch(branch))
        await discardConversationCheckoutByBranch(branch!);
      // Closing an unmerged change is the other abandonment path — same sweep (§4.4).
      await sweepPendingSecrets(project.id);
      throw redirect(back);
    }
    if (intent === "merge") {
      const pullNumber = Number(form.get("pullNumber"));
      const branch = String(form.get("branch") ?? "") || undefined;
      const title = String(form.get("title") ?? "");
      if (!pullNumber) return { error: "Missing change to merge." };
      // Authoritative pre-merge gate for assistant conversation branches: build the branch's tree
      // exactly as it will exist after merge (tarball at the branch ref, NO draft overlay). The
      // model's own in-sandbox checks are advisory; this is the one that blocks a bad merge.
      if (isConversationBranch(branch)) {
        const checkBuild = getRuntime().deployTarget.checkBuild;
        if (checkBuild) {
          const agentRoot = String(form.get("agentRoot") ?? "") || undefined;
          const check = await checkBuild({
            projectId: project.id,
            repo,
            ref: branch!,
            installationId: project.repoInstallationId,
            overlay: [],
            agentRoot,
          });
          if (!check.ok) {
            return {
              error: `This change doesn't build yet, so it can't be merged:\n${check.output}`,
            };
          }
        }
      }
      // Merge → one commit on the default branch (the version identity) → a Release per
      // roster member (idempotent with the webhook path; team merges are atomic, §7.9).
      const { mergeSha } = await mergePullRequest(
        project.repoInstallationId,
        repo,
        pullNumber,
        branch,
      );
      try {
        const source = await fetchAgentSource(project.repoInstallationId, {
          ...repo,
          ref: mergeSha,
        });
        const detected = detectAgentRoots(source.paths);
        await syncProjectAgents(project.id, detected, undefined, undefined, {
          allowEmpty:
            project.layout === "team" &&
            hasTeamLayout(source.paths) &&
            detected.length === 0,
        });
        invalidateRepoSource(project.repoInstallationId, repo);
        warmAgentSource(project.repoInstallationId, repo, {
          ...source,
          ref: project.defaultBranch,
        });
      } catch (error) {
        console.warn("[deployment] merged but couldn't sync roster:", error);
      }
      const results = await ensureReleasesForCommit({
        projectId: project.id,
        gitSha: mergeSha,
        changelog: `#${pullNumber} ${title}`.trim(),
        createdBy: auth.user.id,
      });
      if (isConversationBranch(branch))
        await discardConversationCheckoutByBranch(branch!);
      const version = results[0]?.release.version ?? "";
      throw redirect(`${back}?released=${encodeURIComponent(version)}`);
    }

    // ── Environment CRUD (team-level: create/rename/delete a NAME across the whole roster) ──
    if (intent === "env-create") {
      await createTeamEnvironment({
        projectId: project.id,
        name: String(form.get("name") ?? ""),
        orgId: project.orgId,
        createdBy: auth.user.id,
      });
      return { ok: true as const };
    }
    if (intent === "env-rename") {
      await renameTeamEnvironment({
        projectId: project.id,
        from: String(form.get("from") ?? ""),
        to: String(form.get("to") ?? form.get("name") ?? ""),
        orgId: project.orgId,
        createdBy: auth.user.id,
      });
      return { ok: true as const };
    }
    if (intent === "env-delete") {
      await deleteTeamEnvironment({
        projectId: project.id,
        name: String(form.get("name") ?? ""),
        orgId: project.orgId,
        createdBy: auth.user.id,
      });
      return { ok: true as const };
    }

    // ── Deploys ──
    // deploy-team-version moves the WHOLE team to a version (by commit) in one environment —
    // the single code path for the team view, single-agent repos, and rollback (deploying an
    // older commit reuses its image; a rebuild forces a fresh build).
    if (intent === "deploy-team-version") {
      ensureWorkerStarted();
      // Issue #26: two agents holding the same GitHub App identity (slug/App ID) means at
      // most one of them ever hears its @mentions — refuse the deploy with names attached.
      // Fingerprint comparison only; no secret is decrypted.
      const credRows = await listAppCredentialRows(project.id);
      for (const credAgentId of new Set(credRows.map((r) => r.agentId))) {
        const conflict = findStoredAppCredentialConflict(credRows, credAgentId);
        if (conflict) {
          const self = credRows.find(
            (r) => r.agentId === credAgentId,
          )!.agentName;
          return {
            error:
              `Agents "${self}" and "${conflict.agentName}" share the same GitHub App ` +
              `(${conflict.key}). Every agent needs its own App — create one from the ` +
              "agent's Deployment tab (Create GitHub App), then deploy again.",
          };
        }
      }
      const rebuild = String(form.get("rebuild") ?? "") === "1";
      // A member with no release at this commit (e.g. added after this historical version)
      // can't move — surface those names so a partial roll never silently skews versions.
      const { skipped } = await deployTeamVersion({
        projectId: project.id,
        gitSha: String(form.get("gitSha") ?? ""),
        envName: String(form.get("env") ?? ""),
        rollback: !rebuild,
        rebuild,
        createdBy: auth.user.id,
      });
      return { ok: true as const, skipped: skipped.map((s) => s.agentName) };
    }
    // retry re-queues a single member env's failed deploy (keyed by environmentId — an
    // operational fix that stays harmless in every view).
    if (intent === "retry") {
      ensureWorkerStarted();
      await queueDeploy({
        environmentId: String(form.get("environmentId")),
        releaseId: String(form.get("releaseId")),
        rollback: true,
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
  return [{ title: "Deployment · eden" }];
}

type LoaderData = Route.ComponentProps["loaderData"];
type Env = LoaderData["envs"][number]["env"];
type DeploymentRow = LoaderData["envs"][number]["deployments"][number];
type ReleaseRow = LoaderData["releases"][number];
type EnvState = { env: Env; deployments: DeploymentRow[] };
type DraftRow = LoaderData["drafts"][number];
type ChangeRow = LoaderData["changes"][number];

const IN_FLIGHT = new Set(["queued", "pending", "building"]);
const DISCORD_SECRET_NAMES = new Set([
  "DISCORD_APPLICATION_ID",
  "DISCORD_PUBLIC_KEY",
]);
const GITHUB_SECRET_NAMES = new Set([
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_APP_SLUG",
]);

function isDiscordSecretRequirement(secret: { name: string }): boolean {
  return DISCORD_SECRET_NAMES.has(secret.name);
}

function isGitHubSecretRequirement(secret: { name: string }): boolean {
  return GITHUB_SECRET_NAMES.has(secret.name);
}

function PublishStatus({ active }: { active: boolean }) {
  if (!active) return null;
  return (
    <div
      className="mt-3 rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground"
      role="status"
      aria-live="polite"
    >
      Checking the build and opening a change request. This can take a minute.
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-border">
        <div className="eden-loading-line bg-primary/60" />
      </div>
    </div>
  );
}

/** The deployment an environment is currently running (post-M5.6 there is at most one). */
function runningOf(deployments: DeploymentRow[]): DeploymentRow | undefined {
  return deployments.find((d) => d.status === "live");
}

/** A tinted glyph square marking a pipeline card's role — keeps the surfaces scannable. */
function CardGlyph({
  icon: Icon,
  accent,
}: {
  icon: LucideIcon;
  accent: Accent;
}) {
  return (
    <span
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-md",
        accentChip[accent],
      )}
    >
      <Icon className="size-3.5" aria-hidden />
    </span>
  );
}

export default function Deployment({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { project, roster, activeAgent, isTeam, level, view } = loaderData;
  const memberBase = contextPath(
    project.id,
    level === "member" ? activeAgent : null,
  );
  const [params] = useSearchParams();
  const justReleased = params.get("released");
  const justInstalled = params.get("installed");
  // Connection connect/reconnect outcome (issue #69): the Google callback redirects back here with
  // `connected` and, when the agent was live, a `redeploy` result the auto-redeploy produced.
  const connected = params.get("connected");
  const redeploy = params.get("redeploy");
  const redeployError = params.get("redeployError");
  const connectedLabel = connected === "google" ? "Google" : connected;

  // Progress: re-fetch faster while any deployment is queued/building. A slower
  // baseline poll runs regardless, so a deploy STARTED after this page loaded is
  // picked up on its own rather than staying stale until a manual refresh, and
  // the tail-end clear can't be missed either (issue #41).
  const inFlight = loaderData.envs.some(({ deployments }) =>
    deployments.some((d) => IN_FLIGHT.has(d.status)),
  );
  useLiveRevalidate({ active: inFlight });

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
      <AgentNav
        base={memberBase}
        level={level}
        roster={roster}
        activeAgent={level === "member" ? activeAgent : undefined}
      />
      <PageHeader
        icon={Rocket}
        accent="emerald"
        title={
          level === "member" ? `Deployment — ${activeAgent}` : "Deployment"
        }
        description={
          view === "repo"
            ? "The team's pipeline: staged changes by member, change requests (merging cuts a version for every member), and each member's latest version."
            : "The pipeline for this agent: staged changes become a change request; merging cuts a version; each environment runs one version. Rollback is just deploying an older version again."
        }
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

      {justInstalled && (
        <Alert className="mb-6">
          <AlertTitle>{justInstalled} install staged</AlertTitle>
          <AlertDescription>
            Review and publish it with your other staged changes below.
          </AlertDescription>
        </Alert>
      )}

      {connected &&
        (redeploy === "error" ? (
          <Alert variant="destructive" className="mb-6">
            <AlertTitle>
              {connectedLabel} connected, but the redeploy couldn&apos;t be started
            </AlertTitle>
            <AlertDescription className="whitespace-pre-wrap">
              {redeployError}. The connection is saved — redeploy the current version manually from
              the version history below.
            </AlertDescription>
          </Alert>
        ) : redeploy === "queued" ? (
          <Alert className="mb-6">
            <AlertTitle>{connectedLabel} connected — applying the new credentials</AlertTitle>
            <AlertDescription>
              The running version is redeploying so the new credentials take effect. Watch the
              Environments card below for progress.
            </AlertDescription>
          </Alert>
        ) : redeploy === "staged" ? (
          <Alert className="mb-6">
            <AlertTitle>{connectedLabel} connected</AlertTitle>
            <AlertDescription>
              You have staged changes, so the running version wasn&apos;t redeployed automatically.
              Ship your staged changes to deploy them with the new credentials, or redeploy the
              current version from the version history below.
            </AlertDescription>
          </Alert>
        ) : (
          <Alert className="mb-6">
            <AlertTitle>{connectedLabel} connected</AlertTitle>
            <AlertDescription>
              The connection is saved. Deploy this agent to start using it.
            </AlertDescription>
          </Alert>
        ))}

      {actionData?.error && (
        <Alert variant="destructive" className="mb-6">
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription className="whitespace-pre-wrap">
            {actionData.error}
          </AlertDescription>
        </Alert>
      )}

      {view === "repo" ? (
        <>
          {roster.length === 0 && (
            <EmptyTeamState overviewHref={`/repos/${project.id}`} />
          )}
          {(roster.length > 0 ||
            loaderData.changes.length > 0 ||
            loaderData.draftGroups.length > 0) && (
            <TeamRollup loaderData={loaderData} />
          )}
        </>
      ) : (
        <MemberPipeline loaderData={loaderData} />
      )}
    </AppShell>
  );
}

/* ────────────────────────────── member pipeline ────────────────────────────── */

function MemberPipeline({ loaderData }: { loaderData: LoaderData }) {
  const {
    project,
    drafts,
    changes,
    releases,
    envs,
    activeAgent,
    isTeam,
    canAct,
  } = loaderData;
  // Where "open" on a running deployment points: the agent's playground, not the instance's
  // internal URL (a 127.0.0.1:<port> that's unreachable from a browser).
  const playgroundPath = `${contextPath(project.id, isTeam ? activeAgent : null)}/playground`;

  return (
    <>
      <StagedChangesCard drafts={drafts} isTeam={isTeam} />
      <ChangeRequests changes={changes} isTeam={isTeam} />
      <EnvironmentsCard
        envs={envs}
        canAct={canAct}
        releases={releases}
        playgroundPath={playgroundPath}
      />
      <VersionHistory
        releases={releases}
        envs={envs}
        canAct={canAct}
        guard={{
          missing: loaderData.missingSecrets,
          activeAgent: loaderData.guardAgent,
          settingsAction: loaderData.guardSettingsAction,
        }}
      />
      <GitHubSetupHelp
        envs={envs}
        setup={loaderData.githubSetup}
        projectId={loaderData.project.id}
        agentName={activeAgent}
      />
      <DiscordSetupHelp
        setup={loaderData.discordSetup}
        projectId={loaderData.project.id}
        agentName={activeAgent}
      />
      <ConnectionsCard
        connections={loaderData.connections}
        configured={loaderData.connectionsConfigured}
        projectId={loaderData.project.id}
        agentName={activeAgent}
      />
    </>
  );
}

/**
 * Auth-brokered connections (issue #30): the ONE place a connector's OAuth account is connected and
 * reconnected — installs no longer gate on it, so a row exists for every provider the lock REQUIRES,
 * even before any grant. Each row routes to /google/connect (returnTo = this Deployment tab) and, per
 * its loader-derived state, offers Connect (no grant), a subtle Reconnect (covered), or a primary
 * Reconnect (under-scoped / expired / revoked). Visual language mirrors the Discord card.
 */
function ConnectionsCard({
  connections,
  configured,
  projectId,
  agentName,
}: {
  connections: LoaderData["connections"];
  configured: boolean;
  projectId: string;
  agentName: string;
}) {
  if (connections.length === 0) return null;
  const returnTo = `${contextPath(projectId, agentName)}/deployment`;
  const providerLabel = (p: string) =>
    p === "google" ? "Google" : p.charAt(0).toUpperCase() + p.slice(1);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Connections</CardTitle>
        <CardDescription>
          Accounts this agent is authorized to act on. Connect a new one, or
          reconnect if a grant expires, is revoked, or is missing permissions.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {connections.map((c) => {
          const label = providerLabel(c.provider);
          // The server re-derives requested scopes from this agent's effective lock (falling back
          // to its stored grant only for old locks). Never put an authority-bearing scope list in
          // this browser-controlled URL.
          const connectUrl =
            `/google/connect?project=${encodeURIComponent(projectId)}` +
            `&agent=${encodeURIComponent(agentName)}` +
            `&returnTo=${encodeURIComponent(returnTo)}`;
          return (
            <div
              key={c.id}
              className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2"
            >
              <div className="grid gap-0.5">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{label}</span>
                  {c.state === "not-connected" ? (
                    <Badge variant="outline">not connected</Badge>
                  ) : c.state === "inactive" ? (
                    <Badge variant="warning">{c.status}</Badge>
                  ) : c.state === "under-scoped" ? (
                    <Badge variant="warning">missing permissions</Badge>
                  ) : (
                    <Badge variant="success">connected</Badge>
                  )}
                </div>
                <span className="text-xs text-muted-foreground">
                  {c.state === "not-connected"
                    ? "Not connected"
                    : c.state === "under-scoped"
                      ? `Connected as ${c.accountEmail ?? "your Google account"} — missing permissions this connector needs.`
                      : c.state === "connected"
                        ? `Connected as ${c.accountEmail ?? "your Google account"}`
                        : (c.accountEmail ?? "connected account")}
                </span>
              </div>
              {configured ? (
                // A covered grant is done — only a subtle Reconnect link. Every other state is a
                // to-do (connect, re-scope, or re-auth) and gets the primary button (issue #30).
                c.state === "connected" ? (
                  <Link
                    to={connectUrl}
                    className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                  >
                    Reconnect
                  </Link>
                ) : (
                  <Button asChild variant="default" size="sm">
                    <Link to={connectUrl}>
                      {c.state === "not-connected"
                        ? `Connect ${label}`
                        : "Reconnect"}
                    </Link>
                  </Button>
                )
              ) : (
                <span className="text-xs text-muted-foreground">
                  operator config missing
                </span>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

/** Stage 1: this member's unpublished drafts (+ shared files, which affect everyone). */
function StagedChangesCard({
  drafts,
  isTeam,
}: {
  drafts: DraftRow[];
  isTeam: boolean;
}) {
  const navigation = useNavigation();
  const submit = useSubmit();
  const busy = navigation.state !== "idle" && navigation.formData != null;
  const activeIntent = busy
    ? String(navigation.formData!.get("intent") ?? "")
    : null;

  return (
    <Card className="mb-6">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <CardGlyph icon={FileStack} accent="amber" />
          <CardTitle className="text-base">Staged changes</CardTitle>
          <Badge variant="secondary">{drafts.length}</Badge>
        </div>
      </CardHeader>
      <CardContent>
        {drafts.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing staged. Edits you save — instructions, model, any agent file
            — collect here until you publish them (or ship them with the Quick
            deploy button in the tab row).
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
                    defaultChecked={!d.orphaned}
                    className="size-4 accent-primary"
                    aria-label={`Include ${d.path}`}
                  />
                  <span
                    className={`min-w-0 flex-1 truncate font-mono text-xs ${
                      d.content === null
                        ? "line-through decoration-destructive/60"
                        : ""
                    }`}
                  >
                    {d.path}
                  </span>
                  {d.orphaned && <Badge variant="destructive">orphaned</Badge>}
                  {d.content === null && (
                    <Badge
                      variant="outline"
                      className="text-destructive border-destructive/40"
                    >
                      delete
                    </Badge>
                  )}
                  {d.shared && isTeam && (
                    <Badge variant="outline">
                      shared · affects all members
                    </Badge>
                  )}
                  <span className="shrink-0 text-xs text-muted-foreground">
                    <RelativeTime value={d.updatedAt} />
                  </span>
                  <ConfirmDialog
                    trigger={
                      <Button
                        variant="ghost"
                        size="sm"
                        type="button"
                        disabled={busy}
                      >
                        Discard
                      </Button>
                    }
                    title={`Discard staged change to ${d.path}?`}
                    description={
                      d.content === null
                        ? "Undoes the staged deletion — the file stays in the repository."
                        : "The unpublished edit is deleted. The file itself is untouched — only the staged draft is lost."
                    }
                    confirmLabel="Discard"
                    onConfirm={() =>
                      submit(
                        { intent: "discard", path: d.path },
                        { method: "post" },
                      )
                    }
                  />
                </li>
              ))}
            </ul>
            {drafts.some((d) => d.orphaned) && (
              <p className="mt-2 text-xs text-muted-foreground">
                Orphaned changes belong to a member that&rsquo;s no longer on the
                team. They&rsquo;re unchecked and can&rsquo;t be published —
                discard them.
              </p>
            )}
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Input
                name="title"
                placeholder="Change title (optional)"
                className="h-9 w-full sm:w-72"
              />
              <Button type="submit" disabled={busy}>
                {activeIntent === "publish"
                  ? "Publishing…"
                  : "Publish selected as change request"}
              </Button>
            </div>
            <PublishStatus active={activeIntent === "publish"} />
          </Form>
        )}
      </CardContent>
    </Card>
  );
}

/** Stage 2: open change requests (repo-wide — a merge cuts a version for every member). */
function ChangeRequests({
  changes,
  isTeam,
}: {
  changes: ChangeRow[];
  isTeam: boolean;
}) {
  const navigation = useNavigation();
  const busy = navigation.state !== "idle" && navigation.formData != null;
  const activeIntent = busy
    ? String(navigation.formData!.get("intent") ?? "")
    : null;
  const mergingNumber =
    activeIntent === "merge"
      ? Number(navigation.formData!.get("pullNumber"))
      : null;
  const deletingNumber =
    activeIntent === "delete-change"
      ? Number(navigation.formData!.get("pullNumber"))
      : null;

  if (changes.length === 0) return null;
  return (
    <div className="mb-6">
      <div className="mb-3 flex items-center gap-2">
        <CardGlyph icon={GitPullRequest} accent="brand" />
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

/**
 * The eve build directory for a conversation PR's changed files: a single team member's agent dir
 * when every non-config path is under one `agents/<member>/`, otherwise undefined (the repo root —
 * a single-agent repo). `.eden/**` config files don't belong to any build and are ignored.
 */
function inferAgentRoot(paths: string[]): string | undefined {
  const members = new Set<string>();
  for (const p of paths) {
    if (p.startsWith(".eden/")) continue;
    const m = p.match(/^agents\/([^/]+)\//);
    if (!m) return undefined; // a repo-root / `agent/` file → build the repo root
    members.add(m[1]);
  }
  return members.size === 1 ? `agents/${[...members][0]}/agent` : undefined;
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
  // Build directory for the pre-merge gate on a conversation branch: a single team member's dir
  // when every changed file lives under one `agents/<m>/`, else the repo root (single-agent repo).
  const agentRoot = inferAgentRoot(change.files.map((f) => f.path));

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
              {agentRoot && (
                <input type="hidden" name="agentRoot" value={agentRoot} />
              )}
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
              <li key={f.path} className="px-3 py-1.5">
                {f.patch ? (
                  <details className="group">
                    <summary className="flex cursor-pointer items-center justify-between gap-3 [&::-webkit-details-marker]:hidden">
                      <span className="truncate font-mono text-xs group-open:font-medium">
                        {f.path}
                      </span>
                      <span className="flex shrink-0 items-center gap-2 font-mono text-xs">
                        <span className="text-emerald-600 dark:text-emerald-400">
                          +{f.additions}
                        </span>
                        <span className="text-destructive">−{f.deletions}</span>
                      </span>
                    </summary>
                    <div className="mt-2">
                      <DiffView patch={f.patch} />
                    </div>
                  </details>
                ) : (
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate font-mono text-xs">{f.path}</span>
                    <span className="flex shrink-0 items-center gap-2 font-mono text-xs">
                      <span className="text-emerald-600 dark:text-emerald-400">
                        +{f.additions}
                      </span>
                      <span className="text-destructive">−{f.deletions}</span>
                    </span>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {conflicted && (
          <p className="mt-3 text-xs text-destructive">
            Conflicts with the current default branch — re-stage the files from
            a fresh edit.
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
  if (checking) return <Badge variant="warning">checking…</Badge>;
  if (conflicted) return <Badge variant="destructive">conflicts</Badge>;
  return <Badge variant="success">ready</Badge>;
}

/* ────────────────────────────── team rollup ────────────────────────────── */

function TeamRollup({ loaderData }: { loaderData: LoaderData }) {
  const { project, draftGroups, changes, members, teamEnvs, teamVersions } =
    loaderData;
  const navigation = useNavigation();
  const submit = useSubmit();
  const anyOrphaned = draftGroups.some((g) => g.drafts.some((d) => d.orphaned));
  const totalDrafts = draftGroups.reduce((n, g) => n + g.drafts.length, 0);
  const memberNames = new Set(members.map((m) => m.name));
  const busy = navigation.state !== "idle" && navigation.formData != null;
  const activeIntent = busy
    ? String(navigation.formData!.get("intent") ?? "")
    : null;

  return (
    <>
      <Card className="mb-6">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <CardGlyph icon={FileStack} accent="amber" />
            <CardTitle className="text-base">Staged changes</CardTitle>
            <Badge variant="secondary">{totalDrafts}</Badge>
          </div>
        </CardHeader>
        <CardContent>
          {totalDrafts === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing staged anywhere. Members' edits collect here until
              published.
            </p>
          ) : (
            <Form method="post" className="space-y-4">
              <input type="hidden" name="intent" value="publish" />
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
                    ) : memberNames.has(g.owner) ? (
                      <Link
                        to={`${contextPath(project.id, g.owner)}/deployment`}
                        className="underline-offset-4 hover:underline"
                      >
                        {g.owner}
                      </Link>
                    ) : (
                      <>
                        {g.owner}{" "}
                        <Badge variant="outline" className="align-middle">
                          new member
                        </Badge>
                      </>
                    )}
                  </p>
                  <ul className="divide-y rounded-lg border text-sm">
                    {g.drafts.map((d) => (
                      <li
                        key={d.id}
                        className="flex items-center gap-3 px-3 py-1.5"
                      >
                        <input
                          type="checkbox"
                          name="path"
                          value={d.path}
                          defaultChecked={!d.orphaned}
                          className="size-4 accent-primary"
                          aria-label={`Include ${d.path}`}
                        />
                        <span
                          className={`min-w-0 flex-1 truncate font-mono text-xs ${
                            d.content === null
                              ? "line-through decoration-destructive/60"
                              : ""
                          }`}
                        >
                          {d.path}
                        </span>
                        {d.orphaned && (
                          <Badge variant="destructive">orphaned</Badge>
                        )}
                        {d.content === null && (
                          <Badge
                            variant="outline"
                            className="text-destructive border-destructive/40"
                          >
                            delete
                          </Badge>
                        )}
                        <span className="shrink-0 text-xs text-muted-foreground">
                          <RelativeTime value={d.updatedAt} />
                        </span>
                        <ConfirmDialog
                          trigger={
                            <Button
                              variant="ghost"
                              size="sm"
                              type="button"
                              disabled={busy}
                            >
                              Discard
                            </Button>
                          }
                          title={`Discard staged change to ${d.path}?`}
                          description={
                            d.content === null
                              ? "Undoes the staged deletion — the file stays in the repository."
                              : "The unpublished edit is deleted. The file itself is untouched — only the staged draft is lost."
                          }
                          confirmLabel="Discard"
                          onConfirm={() =>
                            submit(
                              { intent: "discard", path: d.path },
                              { method: "post" },
                            )
                          }
                        />
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {anyOrphaned && (
                <p className="text-xs text-muted-foreground">
                  Orphaned changes belong to a member that&rsquo;s no longer on
                  the team. They&rsquo;re unchecked and can&rsquo;t be published
                  — discard them.
                </p>
              )}
              <div className="flex flex-wrap items-center gap-3">
                <Input
                  name="title"
                  placeholder="Change title (optional)"
                  className="h-9 w-full sm:w-72"
                />
                <Button type="submit" disabled={busy}>
                  {activeIntent === "publish"
                    ? "Publishing…"
                    : "Publish selected as change request"}
                </Button>
              </div>
              <PublishStatus active={activeIntent === "publish"} />
            </Form>
          )}
        </CardContent>
      </Card>

      <ChangeRequests changes={changes} isTeam />

      <TeamEnvironmentsCard teamEnvs={teamEnvs} project={project} />
      <TeamVersionHistory
        teamVersions={teamVersions}
        teamEnvNames={loaderData.teamEnvNames}
        guard={{
          missing: loaderData.missingSecrets,
          activeAgent: loaderData.guardAgent,
          settingsAction: loaderData.guardSettingsAction,
        }}
      />
    </>
  );
}

/* ─────────────────────── team environments + versions ─────────────────────── */

/**
 * The team's environments: one row per env NAME, and under it each member's running version /
 * in-flight / failed state. Team CRUD (create/rename/delete a NAME) fans out across the roster —
 * the dialogs say so. retry/clear-failed stay keyed by the member's environmentId.
 */
function TeamEnvironmentsCard({
  teamEnvs,
  project,
}: {
  teamEnvs: TeamEnvRow[];
  project: ConnectedProject;
}) {
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const error =
    fetcher.data && "error" in fetcher.data ? fetcher.data.error : null;

  return (
    <Card className="mb-6">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2">
            <CardGlyph icon={Server} accent="emerald" />
            <CardTitle className="text-base">Environments</CardTitle>
          </span>
          <EnvNameDialog
            intent="env-create"
            trigger={
              <Button size="sm" variant="outline" disabled={busy}>
                New environment
              </Button>
            }
            title="New environment"
            description="A separate place to run the team — every member gets a matching environment, with its own running version and environment-scoped secrets. Deploy into it from the version history."
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
        {teamEnvs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No environments yet.</p>
        ) : (
          <div className="space-y-4">
            {teamEnvs.map((te) => (
              <div key={te.name} className="rounded-lg border">
                <div className="flex items-center justify-between gap-2 border-b px-4 py-2">
                  <span className="font-medium">{te.name}</span>
                  <span className="flex items-center gap-1">
                    <EnvNameDialog
                      intent="env-rename"
                      from={te.name}
                      initialName={te.name}
                      trigger={
                        <Button size="sm" variant="ghost" disabled={busy}>
                          Rename
                        </Button>
                      }
                      title={`Rename ${te.name}?`}
                      description="Renames this environment for every member — deploys, secrets, and history stay attached, only the name changes. Applies across the whole team."
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
                      title={`Delete environment "${te.name}"?`}
                      description={`Deletes "${te.name}" for EVERY member — stops anything running there and permanently removes its deployment history and environment-scoped secrets. Agent-wide secrets and versions are untouched.`}
                      confirmLabel="Delete"
                      onConfirm={() =>
                        fetcher.submit(
                          { intent: "env-delete", name: te.name },
                          { method: "post" },
                        )
                      }
                    />
                  </span>
                </div>
                <ul className="divide-y text-sm">
                  {te.members.map((m) => (
                    <TeamEnvMemberRow
                      key={m.name}
                      member={m}
                      projectId={project.id}
                      fetcher={fetcher}
                      busy={busy}
                    />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** One member's status inside a team environment row: running version, in-flight, failed. */
function TeamEnvMemberRow({
  member,
  projectId,
  fetcher,
  busy,
}: {
  member: TeamEnvMember;
  projectId: string;
  fetcher: ReturnType<typeof useFetcher<typeof action>>;
  busy: boolean;
}) {
  const running = runningOf(member.deployments);
  const pending = member.deployments.find((d) => IN_FLIGHT.has(d.status));
  const failed = member.deployments.find((d) => d.status === "failed");
  const failedCount = member.deployments.filter(
    (d) => d.status === "failed",
  ).length;

  return (
    <li className="px-4 py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Link
          to={contextPath(projectId, member.name)}
          className="min-w-32 font-mono text-xs underline-offset-4 hover:underline"
        >
          {member.name}
        </Link>
        {running ? (
          <>
            <span className="flex items-center gap-1.5 font-semibold text-emerald-600 dark:text-emerald-400">
              <span
                className="size-1.5 rounded-full bg-emerald-500"
                aria-hidden
              />
              {running.version}
            </span>
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
              {running.gitSha.slice(0, 7)}
            </code>
            <span className="text-muted-foreground">
              deployed <RelativeTime value={running.createdAt} />
            </span>
          </>
        ) : (
          <span className="text-muted-foreground">Nothing deployed</span>
        )}
      </div>
      {pending && (
        <p className="mt-1 text-sm text-muted-foreground">
          <span className="font-medium text-amber-600 dark:text-amber-400">
            {pending.version}{" "}
            {pending.status === "building" ? "building" : "queued"}…
          </span>{" "}
          switches over once healthy
          {running ? `; ${running.version} keeps serving` : ""}.
        </p>
      )}
      {failed && member.envId && (
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-destructive">
          <span className="size-1.5 rounded-full bg-destructive" aria-hidden />
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
            <input type="hidden" name="environmentId" value={member.envId} />
            <input type="hidden" name="releaseId" value={failed.releaseId} />
            <Button type="submit" size="sm" variant="ghost" disabled={busy}>
              Retry
            </Button>
          </fetcher.Form>
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="clear-failed" />
            <input type="hidden" name="environmentId" value={member.envId} />
            <Button type="submit" size="sm" variant="ghost" disabled={busy}>
              Dismiss{failedCount > 1 ? ` ${failedCount} failures` : ""}
            </Button>
          </fetcher.Form>
        </div>
      )}
    </li>
  );
}

/**
 * The team's version history: versions grouped by commit, newest first, badged with the
 * environments running them. "Deploy" per environment moves the WHOLE team to that version —
 * direction-neutral (deploying an older version IS the rollback). The deploy guard triggers when
 * ANY member has missing required secrets.
 */
function TeamVersionHistory({
  teamVersions,
  teamEnvNames,
  guard,
}: {
  teamVersions: TeamVersionRow[];
  teamEnvNames: string[];
  guard: DeployGuard;
}) {
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const skipped =
    (fetcher.data && "skipped" in fetcher.data ? fetcher.data.skipped : []) ??
    [];

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <CardGlyph icon={History} accent="indigo" />
          <CardTitle className="text-base">Version history</CardTitle>
        </div>
      </CardHeader>
      <CardContent>
        {skipped.length > 0 && (
          <Alert className="mb-4">
            <AlertTitle>
              Some members stayed on their current version
            </AlertTitle>
            <AlertDescription>
              {skipped.join(", ")} had no build at this commit, so they were
              left behind. Ship them a version to bring the team back in sync.
            </AlertDescription>
          </Alert>
        )}
        {teamVersions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No versions yet. Ship from the Overview, or merge a change request
            above.
          </p>
        ) : (
          <ul className="divide-y rounded-lg border text-sm">
            {teamVersions.map((v) => (
              <li key={v.gitSha} className="flex items-center gap-2 px-4 py-2">
                <span className="w-10 shrink-0 font-semibold">{v.version}</span>
                <span className="flex shrink-0 items-center gap-1">
                  {v.runningEnvNames.map((name) => (
                    <Badge key={name} variant="secondary">
                      {name}
                    </Badge>
                  ))}
                </span>
                <code className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                  {v.gitSha.slice(0, 7)}
                </code>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {v.changelog}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  <RelativeTime value={v.createdAt} />
                </span>
                <TeamDeployControl
                  version={v}
                  teamEnvNames={teamEnvNames}
                  busy={busy}
                  guard={guard}
                  onDeploy={(env, gitSha, rebuild) =>
                    fetcher.submit(
                      {
                        intent: "deploy-team-version",
                        env,
                        gitSha,
                        ...(rebuild ? { rebuild: "1" } : {}),
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
  );
}

/**
 * The per-version team deploy affordance: pick an environment (a menu when >1) and move the whole
 * team there. Confirm copy says "moves the whole team to <version> in <env>". Redeploy (fresh
 * build) when the version already runs in that env; deploy otherwise — both are the same move.
 */
function TeamDeployControl({
  version,
  teamEnvNames,
  busy,
  guard,
  onDeploy,
}: {
  version: TeamVersionRow;
  teamEnvNames: string[];
  busy: boolean;
  guard: DeployGuard;
  onDeploy: (envName: string, gitSha: string, rebuild: boolean) => void;
}) {
  const [target, setTarget] = useState<string | null>(null);
  const [guardEnv, setGuardEnv] = useState<string | null>(null);
  const guarded = guard.missing.length > 0;
  const runningHere = (name: string) => version.runningEnvNames.includes(name);
  const run = (name: string) =>
    onDeploy(name, version.gitSha, runningHere(name));

  const confirmFor = (name: string) =>
    runningHere(name)
      ? {
          title: `Redeploy ${version.version} to ${name}?`,
          description: `Rebuilds a fresh image from this version's commit and moves the whole team's ${name} over once healthy. The current instances keep serving until then.`,
        }
      : {
          title: `Deploy ${version.version} to ${name}?`,
          description: `Moves the whole team to ${version.version} in ${name}. Each member's ${name} switches over once healthy; the current version keeps serving until then. To switch back, deploy the previous version again.`,
        };

  const pick = (name: string) =>
    guarded ? setGuardEnv(name) : setTarget(name);

  if (teamEnvNames.length === 0) return null;
  const single = teamEnvNames.length === 1 ? teamEnvNames[0] : null;

  return (
    <>
      {single ? (
        <Button
          size="sm"
          variant={runningHere(single) ? "outline" : "secondary"}
          disabled={busy}
          onClick={() => pick(single)}
        >
          {runningHere(single) ? "Redeploy" : "Deploy"}
        </Button>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="secondary" disabled={busy}>
              Deploy ▾
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {teamEnvNames.map((name) => (
              <DropdownMenuItem key={name} onSelect={() => pick(name)}>
                {runningHere(name)
                  ? `Redeploy in ${name}`
                  : `Deploy to ${name}`}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {target && (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setTarget(null);
          }}
          title={confirmFor(target).title}
          description={confirmFor(target).description}
          confirmLabel={runningHere(target) ? "Redeploy" : "Deploy"}
          variant="default"
          onConfirm={() => {
            run(target);
            setTarget(null);
          }}
        />
      )}
      {guardEnv && (
        <DeploySecretsGuardDialog
          open
          onOpenChange={(open) => {
            if (!open) setGuardEnv(null);
          }}
          missing={guard.missing}
          activeAgent={guard.activeAgent}
          settingsAction={guard.settingsAction}
          deployLabel={runningHere(guardEnv) ? "Redeploy" : "Deploy"}
          onDeploy={() => {
            run(guardEnv);
            setGuardEnv(null);
          }}
        />
      )}
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
  canAct,
  releases,
  playgroundPath,
}: {
  envs: EnvState[];
  canAct: boolean;
  releases: ReleaseRow[];
  playgroundPath: string;
}) {
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const error =
    fetcher.data && "error" in fetcher.data ? fetcher.data.error : null;

  return (
    <Card className="mb-6">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2">
            <CardGlyph icon={Server} accent="emerald" />
            <CardTitle className="text-base">Environments</CardTitle>
          </span>
          {canAct && (
            <EnvNameDialog
              intent="env-create"
              trigger={
                <Button size="sm" variant="outline" disabled={busy}>
                  New environment
                </Button>
              }
              title="New environment"
              description="A separate place to run the team — every member gets a matching environment, with its own running version and its own environment-scoped secrets. Deploy into it from the version history."
              confirmLabel="Create"
            />
          )}
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
            const failedCount = deployments.filter(
              (d) => d.status === "failed",
            ).length;
            return (
              <li key={env.id} className="px-4 py-2">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="min-w-32 font-medium">{env.name}</span>
                  {running ? (
                    <>
                      <span className="flex items-center gap-1.5 font-semibold text-emerald-600 dark:text-emerald-400">
                        <span
                          className="size-1.5 rounded-full bg-emerald-500"
                          aria-hidden
                        />
                        {running.version}
                      </span>
                      {(() => {
                        const f = releaseFreshness(running.releaseId, releases);
                        return f ? (
                          <FreshnessBadge
                            isLatest={f.isLatest}
                            latestVersion={f.latestVersion}
                          />
                        ) : null;
                      })()}
                      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                        {running.gitSha.slice(0, 7)}
                      </code>
                      <span className="text-muted-foreground">
                        deployed <RelativeTime value={running.createdAt} />
                      </span>
                      {/* `url` isn't the link target (it's an instance-internal address) — its
                          presence is the "there's a reachable instance to talk to" signal gating
                          the playground link. */}
                      {running.url && (
                        <Link
                          to={playgroundPath}
                          className="underline underline-offset-4"
                        >
                          open
                        </Link>
                      )}
                    </>
                  ) : (
                    <span className="text-muted-foreground">
                      Nothing deployed — use Ship on the Overview, or Deploy a
                      version below.
                    </span>
                  )}
                  {canAct && (
                    <span className="ml-auto flex items-center gap-1">
                      <EnvNameDialog
                        intent="env-rename"
                        from={env.name}
                        initialName={env.name}
                        trigger={
                          <Button size="sm" variant="ghost" disabled={busy}>
                            Rename
                          </Button>
                        }
                        title={`Rename ${env.name}?`}
                        description="Renames this environment for every member — deploys, secrets, and history stay attached, only the name changes. Applies across the whole team."
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
                        description={`Deletes "${env.name}" for EVERY member — stops anything running there and permanently removes its deployment history and environment-scoped secrets. Agent-wide secrets and versions are untouched.${running ? ` ${running.version} is running here and will be taken down.` : ""}`}
                        confirmLabel="Delete"
                        onConfirm={() =>
                          fetcher.submit(
                            { intent: "env-delete", name: env.name },
                            { method: "post" },
                          )
                        }
                      />
                    </span>
                  )}
                </div>
                {pending && (
                  <p className="mt-1 text-sm text-muted-foreground">
                    <span className="font-medium text-amber-600 dark:text-amber-400">
                      {pending.version}{" "}
                      {pending.status === "building" ? "building" : "queued"}…
                    </span>{" "}
                    switches over once healthy
                    {running ? `; ${running.version} keeps serving` : ""}.
                  </p>
                )}
                {failed && (
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-destructive">
                    <span
                      className="size-1.5 rounded-full bg-destructive"
                      aria-hidden
                    />
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
                      <input
                        type="hidden"
                        name="environmentId"
                        value={env.id}
                      />
                      <input
                        type="hidden"
                        name="releaseId"
                        value={failed.releaseId}
                      />
                      <Button
                        type="submit"
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                      >
                        Retry
                      </Button>
                    </fetcher.Form>
                    <fetcher.Form method="post">
                      <input type="hidden" name="intent" value="clear-failed" />
                      <input
                        type="hidden"
                        name="environmentId"
                        value={env.id}
                      />
                      <Button
                        type="submit"
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                      >
                        Dismiss
                        {failedCount > 1 ? ` ${failedCount} failures` : ""}
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
 * Discord channel setup (issue #32): one-click connect through Eden's shared Discord app. The
 * user clicks Connect Discord, approves one authorization screen, and Eden registers a
 * `/<agent-name>` slash command and routes interactions automatically — no portal, no secrets.
 * Hidden entirely when the operator hasn't configured the shared app (EDEN_DISCORD_*): a card
 * whose only content is "this isn't available" is noise.
 */
function DiscordSetupHelp({
  setup,
  projectId,
  agentName,
}: {
  setup: LoaderData["discordSetup"];
  projectId: string;
  agentName: string;
}) {
  if (!setup.enabled || !setup.configured) return null;

  const connectUrl = `/discord/connect?project=${encodeURIComponent(projectId)}&agent=${encodeURIComponent(agentName)}`;
  const connections = setup.connections ?? [];

  return (
    <Card className="mb-6 mt-6">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <CardGlyph icon={MessageSquare} accent="brand" />
          <CardTitle className="text-base">Discord</CardTitle>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-3 text-sm">
          <p>
            Connect this agent to a Discord server — it answers there as the{" "}
            <code>/{agentName}</code> slash command.
          </p>
          {connections.length > 0 && (
            <ul className="space-y-1 rounded-lg border px-3 py-2">
              {connections.map((c) => (
                <li
                  key={c.id}
                  className="flex flex-wrap items-baseline gap-x-2"
                >
                  <span className="font-medium">
                    {c.guildName ?? `Server ${c.guildId}`}
                  </span>
                  <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                    /{c.commandName}
                  </code>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              asChild
              size="sm"
              variant={connections.length ? "outline" : "default"}
            >
              <Link to={connectUrl}>
                {connections.length
                  ? "Connect another server"
                  : "Connect Discord"}
              </Link>
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * GitHub channel setup (issue #26): the agent listens through its OWN GitHub App. Connect runs
 * the Manifest flow — Eden registers the App, stores its secrets (including the webhook URL),
 * and sends the user to GitHub to pick the repositories it watches.
 */
function GitHubSetupHelp({
  envs,
  setup,
  projectId,
  agentName,
}: {
  envs: EnvState[];
  setup: LoaderData["githubSetup"];
  projectId: string;
  agentName: string;
}) {
  if (!setup.enabled) return null;

  const createUrl = (envId?: string) =>
    `/github/apps/new?project=${encodeURIComponent(projectId)}&agent=${encodeURIComponent(agentName)}${
      envId ? `&env=${encodeURIComponent(envId)}` : ""
    }`;

  return (
    <Card className="mb-6 mt-6">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <CardGlyph icon={Webhook} accent="brand" />
          <CardTitle className="text-base">GitHub</CardTitle>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-3 text-sm">
          <p>
            Connect this agent to GitHub — it answers <code>@mentions</code> in
            issues and pull requests on the repositories you install it on.
          </p>
          {setup.appSlug && (
            <div className="space-y-2">
              <p className="font-medium">
                Connected as <code>@{setup.appSlug}</code>
              </p>
              {setup.installations === null ? (
                <p className="text-muted-foreground">
                  Couldn&rsquo;t reach GitHub to list where it&rsquo;s installed
                  —{" "}
                  <a
                    href={`https://github.com/apps/${encodeURIComponent(setup.appSlug)}/installations/new`}
                    target="_blank"
                    rel="noreferrer"
                    className="underline underline-offset-2"
                  >
                    manage installations on GitHub
                  </a>
                  .
                </p>
              ) : setup.installations.length === 0 ? (
                <p className="text-muted-foreground">
                  Not installed on any account yet — it can&rsquo;t see any
                  repositories until it is.
                </p>
              ) : (
                <ul className="space-y-1 rounded-lg border px-3 py-2">
                  {setup.installations.map((inst) => (
                    <li
                      key={`${inst.accountType}:${inst.account}`}
                      className="flex flex-wrap items-baseline gap-x-2"
                    >
                      <span className="font-medium">{inst.account}</span>
                      <span className="text-xs text-muted-foreground">
                        {inst.accountType === "Organization"
                          ? "organization"
                          : "personal account"}
                        {" · "}
                        {inst.repositorySelection === "all"
                          ? "all repositories"
                          : "selected repositories"}
                      </span>
                      {inst.htmlUrl && (
                        <a
                          href={inst.htmlUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs underline underline-offset-2"
                        >
                          change repositories
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {setup.appSlug && setup.installations !== null && (
              <Button asChild size="sm">
                <a
                  href={`https://github.com/apps/${encodeURIComponent(setup.appSlug)}/installations/new`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {setup.installations.length === 0
                    ? "Install the App"
                    : "Add another account or organization"}
                </a>
              </Button>
            )}
            <Button
              asChild
              size="sm"
              variant={setup.appSlug ? "outline" : "default"}
            >
              <Link to={createUrl(envs[0]?.env.id)}>
                {setup.appSlug ? "Reconnect GitHub" : "Connect GitHub"}
              </Link>
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Every version, newest first, badged with the environments it's running on. "Deploy" is
 * deliberately direction-neutral — deploying an older version IS the rollback (cutover on
 * health; a built image starts in seconds).
 */
/** Deploy-guard context threaded to each version's deploy control (§9). */
interface DeployGuard {
  missing: GuardMissingSecret[];
  activeAgent: string;
  settingsAction: string;
}

function VersionHistory({
  releases,
  envs,
  canAct,
  guard,
}: {
  releases: ReleaseRow[];
  envs: EnvState[];
  canAct: boolean;
  guard: DeployGuard;
}) {
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  // A team of one still deploys through the TEAM path: address the target by env NAME + commit.
  const deploy = (envName: string, gitSha: string) =>
    fetcher.submit(
      { intent: "deploy-team-version", env: envName, gitSha },
      { method: "post" },
    );
  const redeploy = (envName: string, gitSha: string) =>
    fetcher.submit(
      { intent: "deploy-team-version", env: envName, gitSha, rebuild: "1" },
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
        <div className="flex items-center gap-2">
          <CardGlyph icon={History} accent="indigo" />
          <CardTitle className="text-base">Version history</CardTitle>
        </div>
      </CardHeader>
      <CardContent>
        {!canAct && (
          <p className="mb-3 text-sm text-muted-foreground">
            Deploys happen at the team level — use the team Deployment tab.
          </p>
        )}
        {releases.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No versions yet. Ship from the Overview, or merge a change request
            above.
          </p>
        ) : (
          <ul className="divide-y rounded-lg border text-sm">
            {releases.map((r, i) => (
              <li key={r.id} className="flex items-center gap-2 px-4 py-2">
                <span className="w-10 shrink-0 font-semibold">{r.version}</span>
                <span className="flex shrink-0 items-center gap-1">
                  {i === 0 && <Badge variant="success">Latest</Badge>}
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
                  <RelativeTime value={r.createdAt} />
                </span>
                {canAct && (
                  <DeployControl
                    release={r}
                    envs={envs}
                    busy={busy}
                    guard={guard}
                    onDeploy={deploy}
                    onRedeploy={redeploy}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The per-version deploy affordance. One environment: a plain Deploy button, or Redeploy
 * when the version is already running there. Several: one menu with deploy/redeploy actions
 * per environment. Every deploy confirms — the dialog names the target (the realistic
 * multi-env mistake) and teaches that switching back is just another deploy.
 */
function DeployControl({
  release,
  envs,
  busy,
  guard,
  onDeploy,
  onRedeploy,
}: {
  release: ReleaseRow;
  envs: EnvState[];
  busy: boolean;
  guard: DeployGuard;
  onDeploy: (envName: string, gitSha: string) => void;
  onRedeploy: (envName: string, gitSha: string) => void;
}) {
  type DeployMode = "deploy" | "redeploy";
  const [target, setTarget] = useState<{
    envState: EnvState;
    mode: DeployMode;
  } | null>(null);
  // §9 deploy guard: required secrets still missing → the guard dialog replaces the plain
  // confirm (fix inline, deploy anyway, or cancel). Dismissed requirements never reach here.
  const [guardTarget, setGuardTarget] = useState<{
    envState: EnvState;
    mode: DeployMode;
  } | null>(null);
  const guarded = guard.missing.length > 0;
  const runningHere = (s: EnvState) =>
    runningOf(s.deployments)?.releaseId === release.id;
  const run = (s: EnvState, mode: DeployMode) =>
    mode === "redeploy"
      ? onRedeploy(s.env.name, release.gitSha)
      : onDeploy(s.env.name, release.gitSha);

  const confirmFor = (s: EnvState, mode: DeployMode) => {
    const current = runningOf(s.deployments);
    if (mode === "redeploy") {
      return {
        title: `Redeploy ${release.version} to ${s.env.name}?`,
        description: `Builds a fresh image from this version's commit and switches ${s.env.name} over once it's healthy. The current instance keeps serving until then.`,
      };
    }
    return {
      title: `Deploy ${release.version} to ${s.env.name}?`,
      description: current
        ? `${s.env.name} switches to ${release.version} once it's healthy; ${current.version} keeps serving until then. To switch back, deploy ${current.version} again.`
        : `${release.version} will start running on ${s.env.name}.`,
    };
  };

  if (envs.length === 1) {
    const only = envs[0];
    const mode = runningHere(only) ? "redeploy" : "deploy";
    const copy = confirmFor(only, mode);
    if (guarded) {
      return (
        <>
          <Button
            size="sm"
            variant={mode === "redeploy" ? "outline" : "secondary"}
            disabled={busy}
            onClick={() => setGuardTarget({ envState: only, mode })}
          >
            {mode === "redeploy" ? "Redeploy" : "Deploy"}
          </Button>
          {guardTarget && (
            <DeploySecretsGuardDialog
              open
              onOpenChange={(open) => {
                if (!open) setGuardTarget(null);
              }}
              missing={guard.missing}
              activeAgent={guard.activeAgent}
              settingsAction={guard.settingsAction}
              deployLabel={
                guardTarget.mode === "redeploy" ? "Redeploy" : "Deploy"
              }
              onDeploy={() => {
                run(guardTarget.envState, guardTarget.mode);
                setGuardTarget(null);
              }}
            />
          )}
        </>
      );
    }
    return (
      <ConfirmDialog
        trigger={
          <Button
            size="sm"
            variant={mode === "redeploy" ? "outline" : "secondary"}
            disabled={busy}
          >
            {mode === "redeploy" ? "Redeploy" : "Deploy"}
          </Button>
        }
        title={copy.title}
        description={copy.description}
        confirmLabel={mode === "redeploy" ? "Redeploy" : "Deploy"}
        variant="default"
        onConfirm={() => run(only, mode)}
      />
    );
  }

  const everywhere = envs.every(runningHere);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="secondary" disabled={busy}>
            {everywhere ? "Redeploy" : "Deploy"} ▾
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {envs.map((s) => {
            const mode = runningHere(s)
              ? ("redeploy" as const)
              : ("deploy" as const);
            return (
              <DropdownMenuItem
                key={s.env.id}
                onSelect={() =>
                  guarded
                    ? setGuardTarget({ envState: s, mode })
                    : setTarget({ envState: s, mode })
                }
              >
                {mode === "redeploy"
                  ? `Redeploy in ${s.env.name}`
                  : `Deploy to ${s.env.name}`}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      {target && (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setTarget(null);
          }}
          title={confirmFor(target.envState, target.mode).title}
          description={confirmFor(target.envState, target.mode).description}
          confirmLabel={target.mode === "redeploy" ? "Redeploy" : "Deploy"}
          variant="default"
          onConfirm={() => {
            run(target.envState, target.mode);
            setTarget(null);
          }}
        />
      )}
      {guardTarget && (
        <DeploySecretsGuardDialog
          open
          onOpenChange={(open) => {
            if (!open) setGuardTarget(null);
          }}
          missing={guard.missing}
          activeAgent={guard.activeAgent}
          settingsAction={guard.settingsAction}
          deployLabel={guardTarget.mode === "redeploy" ? "Redeploy" : "Deploy"}
          onDeploy={() => {
            run(guardTarget.envState, guardTarget.mode);
            setGuardTarget(null);
          }}
        />
      )}
    </>
  );
}

/**
 * Shared name dialog for team env create/rename — one text field. Create posts `name`; rename
 * posts `from` (the current name) + `to`. Both apply across every member (team-level CRUD).
 */
function EnvNameDialog({
  intent,
  trigger,
  title,
  description,
  confirmLabel,
  from,
  initialName,
}: {
  intent: "env-create" | "env-rename";
  trigger: React.ReactNode;
  title: string;
  description: string;
  confirmLabel: string;
  /** The current name being renamed (rename only). */
  from?: string;
  initialName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(initialName ?? "");
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const error =
    fetcher.data && "error" in fetcher.data ? fetcher.data.error : null;
  // Stay open until OUR submission settles — success closes, an error (e.g. duplicate
  // name) shows inline so the human can fix the name and retry. The close happens inline
  // on the render where fetcher.data changes (no effect, no stale-frame flash).
  const [prevData, setPrevData] = useState(fetcher.data);
  if (fetcher.data !== prevData) {
    setPrevData(fetcher.data);
    if (open && fetcher.data && "ok" in fetcher.data && fetcher.data.ok) {
      setOpen(false);
      if (intent === "env-create") setName("");
    }
  }
  const submit = () => {
    if (!name.trim()) return;
    fetcher.submit(
      intent === "env-rename"
        ? { intent, from: from ?? "", to: name.trim() }
        : { intent, name: name.trim() },
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
          <Label htmlFor={`env-name-${intent}-${from ?? "new"}`}>Name</Label>
          <Input
            id={`env-name-${intent}-${from ?? "new"}`}
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
