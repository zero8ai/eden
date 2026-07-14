/**
 * Connect pillar (M0): install the GitHub App, pick an eve repo, create a project.
 *
 * Flow:
 *  1. No installation yet -> show "Install on GitHub" (App install URL, org id in `state`).
 *  2. GitHub redirects back here with `?installation_id=...` -> list that installation's repos.
 *  3. User submits a repo -> validate it's an eve repo (`agent/` present) -> create project ->
 *     redirect to its read-only view.
 *
 * Set the GitHub App's "Setup URL" to `<host>/connect` so step 2 lands here.
 */
import { getSessionAuth, sessionLoader } from "~/auth/session.server";
import {
  Form,
  Link,
  data,
  redirect,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { useState } from "react";
import { Download, FolderGit2, Plug, Plus } from "lucide-react";

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
import { createProject } from "~/db/queries.server";
import {
  ensureWorkspace,
  resolveActiveWorkspace,
  type WorkspaceInfo,
} from "~/auth/workspace.server";
import { getInstallUrl } from "~/github/client.server";
import { createEveRepo } from "~/github/create.server";
import {
  githubUserAuthorizeUrl,
  mobileGithubErrorUrl,
  signMobileGithubState,
  toMobileGithubVerifyState,
  verifyMobileGithubState,
} from "~/github/mobile-install.server";
import {
  forgetInstallation,
  listKnownInstallations,
  rememberInstallation,
} from "~/github/installations.server";
import { warmAgentSource } from "~/github/cached.server";
import { getWorkspaceAssistantSelection } from "~/org/workspace.server";
import { ownsWorkspaceModelReference } from "~/models/union.server";
import {
  fetchAgentSource,
  listInstallationRepos,
  type InstallationRepo,
} from "~/github/repo.server";
import { detectAgentRoots, hasTeamLayout, isEveRepo } from "~/eve/parse";
import { slugifyResourceName } from "~/eve/templates";
import { noindexMeta } from "~/lib/seo";
import { publicOrigin } from "~/lib/ingress";
import type { Route } from "./+types/connect";

type GithubConnectState =
  | { state: "no-org" }
  | { state: "install"; installUrl: string }
  | {
      state: "pick";
      installationId: string;
      repos: InstallationRepo[];
      /** Installation's org/user — prefills "create" even when zero repos are shared. */
      accountLogin: string | null;
      /** Always offered so another GitHub org/account can be added. */
      installUrl: string;
    }
  | { state: "unconfigured"; message: string };

interface ConnectView {
  org: WorkspaceInfo | null;
  github: GithubConnectState;
}

export const loader = async (args: LoaderFunctionArgs) => {
  // Native setup returns through the GitHub App's shared web Setup URL. Its signed state carries
  // the initiating native session, so this transition must happen before web session enforcement:
  // the system browser intentionally does not share the native Better Auth cookie.
  const callbackUrl = new URL(args.request.url);
  const callbackState = callbackUrl.searchParams.get("state");
  if (callbackState) {
    const setup = verifyMobileGithubState(callbackState);
    if (setup) {
      if (setup.phase !== "setup") {
        throw data("Invalid native GitHub setup phase.", { status: 400 });
      }
      const verify = toMobileGithubVerifyState(
        setup,
        callbackUrl.searchParams.get("installation_id") ?? "",
      );
      if (!verify) {
        throw redirect(
          mobileGithubErrorUrl(setup.redirectUrl, "invalid_installation"),
        );
      }
      const state = signMobileGithubState(verify);
      const redirectUri = `${publicOrigin(args.request)}/github/mobile-install/callback`;
      throw redirect(githubUserAuthorizeUrl({ redirectUri, state }));
    }
  }

  return sessionLoader(
    args,
    async ({ auth }): Promise<ConnectView> => {
      // First org-less login: provision the user's workspace and replay (redirect).
      await ensureWorkspace(args.request, auth);
      const active = await resolveActiveWorkspace(auth);
      const org = active?.org;
      if (!org) return { org: null, github: { state: "no-org" as const } };

      const url = new URL(args.request.url);

      try {
        const installUrl = getInstallUrl(org.id);
        // Fresh install redirect: GitHub sends us back with the id — remember it so every
        // later visit renders the picker without asking to "install" again.
        const fromRedirect = url.searchParams.get("installation_id");
        if (fromRedirect) {
          await rememberInstallation(org.id, fromRedirect);
        }

        // Try the redirect's installation first, then the org's remembered ones. A stored
        // installation that GitHub no longer honors (uninstalled) is forgotten and skipped.
        const known = await listKnownInstallations(org.id);
        const candidates = [
          ...(fromRedirect ? [fromRedirect] : []),
          ...known
            .map((k) => k.installationId)
            .filter((id) => id !== fromRedirect),
        ];
        for (const installationId of candidates) {
          try {
            const repos = await listInstallationRepos(installationId);
            const accountLogin =
              known.find((k) => k.installationId === installationId)
                ?.accountLogin ?? null;
            return {
              org,
              github: {
                state: "pick" as const,
                installationId,
                repos,
                accountLogin,
                installUrl,
              },
            };
          } catch {
            await forgetInstallation(org.id, installationId);
          }
        }
        return { org, github: { state: "install" as const, installUrl } };
      } catch (error) {
        return {
          org,
          github: {
            state: "unconfigured" as const,
            message: (error as Error).message,
          },
        };
      }
    },
    { ensureSignedIn: true },
  );
};

export async function action(args: ActionFunctionArgs) {
  const auth = await getSessionAuth(args);
  if (!auth.user) throw redirect("/login");

  const active = await resolveActiveWorkspace(auth);
  const org = active?.org;
  if (!org)
    return { error: "You must belong to an organization to connect a repo." };

  const form = await args.request.formData();
  const installationId = String(form.get("installationId") ?? "");
  if (!installationId) return { error: "Missing installation." };
  const intent = String(form.get("intent") ?? "connect");

  // ── Create a new repo + scaffold (eve init) ──
  if (intent === "create") {
    const owner = String(form.get("owner") ?? "").trim();
    const name = String(form.get("name") ?? "").trim();
    const layout =
      form.get("layout") === "team" ? ("team" as const) : ("single" as const);
    const agentName =
      layout === "single"
        ? slugifyResourceName(String(form.get("agentName") ?? ""))
        : "";
    if (!owner || !name)
      return { error: "Owner and repository name are required." };
    if (layout === "single" && !agentName)
      return { error: "Agent name is required." };
    try {
      const selection =
        layout === "single"
          ? await getWorkspaceAssistantSelection(org.id).catch(() => ({
              model: null,
              effort: null,
            }))
          : { model: null, effort: null };
      let model = selection.model;
      if (model && !(await ownsWorkspaceModelReference(org.id, model))) {
        model = null;
      }
      if (layout === "single" && !model) {
        return {
          error:
            "Choose a connected workspace default model in Org settings before creating an agent repository.",
        };
      }
      const repo = await createEveRepo(installationId, {
        owner,
        name,
        layout,
        ...(layout === "single" ? { agentName } : {}),
        ...(model ? { model } : {}),
        ...(model ? { effort: selection.effort } : {}),
      });
      const project = await createProject({
        orgId: org.id,
        name,
        repoOwner: repo.owner,
        repoName: repo.repo,
        repoInstallationId: installationId,
        defaultBranch: repo.defaultBranch,
        layout,
        // The scaffold's roster is known without re-reading the repo (§7.9).
        roster: layout === "team" ? [] : [{ name: agentName, root: "agent" }],
      });
      throw redirect(`/repos/${project.id}`);
    } catch (error) {
      if (error instanceof Response) throw error;
      return { error: (error as Error).message };
    }
  }

  // ── Connect an existing repo ──
  const owner = String(form.get("owner") ?? "");
  const repo = String(form.get("repo") ?? "");
  const defaultBranch = String(form.get("defaultBranch") ?? "main");
  if (!owner || !repo) return { error: "Missing repo selection." };

  // Validate it's an eve project before we persist anything.
  let source;
  try {
    source = await fetchAgentSource(installationId, { owner, repo });
  } catch (error) {
    return {
      error: `Could not read ${owner}/${repo}: ${(error as Error).message}`,
    };
  }
  if (!isEveRepo(source.paths)) {
    return {
      error: `${owner}/${repo} doesn't look like an eve project — no \`agent/\` directory, agents, or \`agents/README.md\` empty-team marker found.`,
    };
  }

  const project = await createProject({
    orgId: org.id,
    name: repo,
    repoOwner: owner,
    repoName: repo,
    repoInstallationId: installationId,
    defaultBranch: source.ref || defaultBranch,
    layout: hasTeamLayout(source.paths) ? "team" : "single",
    // Detected roster: one member per agent root (single repos are a team of one).
    roster: detectAgentRoots(source.paths).map((r) => ({
      name: r.name,
      root: r.root,
    })),
  });

  // We just read the source to validate — warm the cache so the first project load is instant.
  warmAgentSource(installationId, { owner, repo }, source);

  throw redirect(`/repos/${project.id}`);
}

export function meta() {
  return [{ title: "New repository · eden" }, ...noindexMeta];
}

export default function Connect({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { org, github } = loaderData;
  const navigation = useNavigation();
  // Busy is per-FORM, not global: only the clicked button changes label, and it stays busy
  // through the whole navigation (action + redirect + next page's loader) — the redirect
  // target reads the repo from GitHub, which takes a beat; going idle early reads as broken.
  const busyData = navigation.state !== "idle" ? navigation.formData : null;
  const busyIntent = busyData
    ? String(busyData.get("intent") ?? "connect")
    : null;
  const busyRepo = busyData
    ? `${busyData.get("owner")}/${busyData.get("repo")}`
    : null;
  const [layout, setLayout] = useState<"single" | "team">("single");

  return (
    <AppShell>
      <PageHeader
        icon={Plug}
        accent="brand"
        title="New repository"
        description="A repository holds one agent or a team of agents. Connect an existing repo, or scaffold a fresh one."
        actions={
          <Button variant="ghost" asChild>
            <Link to="/dashboard">← Back</Link>
          </Button>
        }
      />

      {actionData?.error && (
        <Alert variant="destructive" className="mb-6">
          <AlertTitle>Couldn&rsquo;t connect</AlertTitle>
          <AlertDescription>{actionData.error}</AlertDescription>
        </Alert>
      )}

      {github.state === "unconfigured" && (
        <Alert className="mb-6">
          <AlertTitle>GitHub App isn&rsquo;t configured yet</AlertTitle>
          <AlertDescription>{github.message}</AlertDescription>
        </Alert>
      )}

      {github.state === "install" && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Download
                className={`size-4 shrink-0 ${accentText.brand}`}
                aria-hidden
              />
              Install the GitHub App
            </CardTitle>
            <CardDescription>
              Install eden on the account that owns your eve repository, then
              pick the repo to connect. You control which repositories it can
              access — selecting none is fine too, if you only want eden to
              create new repos for you.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild>
              <a href={github.installUrl}>Install on GitHub</a>
            </Button>
          </CardContent>
        </Card>
      )}

      {github.state === "pick" && (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FolderGit2
                  className={`size-4 shrink-0 ${accentText.brand}`}
                  aria-hidden
                />
                Connect an existing repository
              </CardTitle>
              <CardDescription>
                Repositories the GitHub App can access. eden validates that the
                repo is an eve project before connecting.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {github.repos.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No repositories are shared with the app yet — that&rsquo;s
                  fine if you only want eden to create repos for you. Create a
                  new repository below, or{" "}
                  <a
                    href={github.installUrl}
                    className="font-medium underline underline-offset-4"
                  >
                    grant the app access
                  </a>{" "}
                  to an existing eve repo on GitHub.
                </p>
              ) : (
                <ul className="divide-y rounded-lg border">
                  {github.repos.map((r) => (
                    <li
                      key={r.fullName}
                      className="flex items-center justify-between gap-3 px-4 py-3"
                    >
                      <div className="flex items-center gap-2 truncate">
                        <span className="truncate font-mono text-sm">
                          {r.fullName}
                        </span>
                        {r.private && (
                          <Badge variant="secondary" className="text-xs">
                            private
                          </Badge>
                        )}
                      </div>
                      <Form method="post">
                        <input
                          type="hidden"
                          name="installationId"
                          value={github.installationId}
                        />
                        <input type="hidden" name="owner" value={r.owner} />
                        <input type="hidden" name="repo" value={r.repo} />
                        <input
                          type="hidden"
                          name="defaultBranch"
                          value={r.defaultBranch}
                        />
                        <Button
                          size="sm"
                          variant="secondary"
                          type="submit"
                          disabled={busyData != null}
                        >
                          {busyIntent === "connect" && busyRepo === r.fullName
                            ? "Connecting…"
                            : "Connect"}
                        </Button>
                      </Form>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Plus
                  className={`size-4 shrink-0 ${accentText.emerald}`}
                  aria-hidden
                />
                Create a new repository
              </CardTitle>
              <CardDescription>
                Creates a repository in your organization and scaffolds it — a
                single agent (<span className="font-mono">agent/</span>) or a
                team of agents (
                <span className="font-mono">agents/&lt;name&gt;/agent/</span>
                ).
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Form method="post" className="space-y-4">
                <input type="hidden" name="intent" value="create" />
                <input
                  type="hidden"
                  name="installationId"
                  value={github.installationId}
                />
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-4 has-[:checked]:border-primary has-[:checked]:bg-muted/40">
                    <input
                      type="radio"
                      name="layout"
                      value="single"
                      checked={layout === "single"}
                      onChange={() => setLayout("single")}
                      className="mt-1 accent-primary"
                    />
                    <span>
                      <span className="block text-sm font-medium">
                        Single agent
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        One agent, one runtime. The repo root holds{" "}
                        <span className="font-mono">agent/</span>.
                      </span>
                    </span>
                  </label>
                  <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-4 has-[:checked]:border-primary has-[:checked]:bg-muted/40">
                    <input
                      type="radio"
                      name="layout"
                      value="team"
                      checked={layout === "team"}
                      onChange={() => setLayout("team")}
                      className="mt-1 accent-primary"
                    />
                    <span>
                      <span className="block text-sm font-medium">Team</span>
                      <span className="block text-xs text-muted-foreground">
                        A monorepo of agents under{" "}
                        <span className="font-mono">agents/</span> — each agent
                        has its own runtime, channels, schedules, and secrets.
                      </span>
                    </span>
                  </label>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="name">Repository name</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id="owner"
                      name="owner"
                      aria-label="GitHub organization"
                      defaultValue={
                        github.accountLogin ?? github.repos[0]?.owner ?? ""
                      }
                      placeholder="org"
                      className="w-full min-w-0 sm:w-40"
                    />
                    <span className="text-muted-foreground">/</span>
                    <Input
                      id="name"
                      name="name"
                      placeholder={layout === "team" ? "my-team" : "my-agent"}
                      className="w-full min-w-0 font-mono sm:w-56"
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Created on GitHub as{" "}
                    <span className="font-mono">
                      {github.accountLogin ?? github.repos[0]?.owner ?? "org"}/
                      {layout === "team" ? "my-team" : "my-agent"}
                    </span>
                    .
                  </p>
                </div>
                {layout === "single" && (
                  <div className="space-y-1.5">
                    <Label htmlFor="agentName">Agent's name</Label>
                    <Input
                      id="agentName"
                      name="agentName"
                      placeholder="product-manager"
                      className="w-full font-mono sm:w-72"
                    />
                    <p className="text-xs text-muted-foreground">
                      Your agent's name. Its code lives at{" "}
                      <span className="font-mono">agent/</span> in the
                      repository.
                    </p>
                  </div>
                )}
                <Button type="submit" disabled={busyData != null}>
                  {busyIntent === "create"
                    ? "Creating & opening…"
                    : "Create & scaffold"}
                </Button>
              </Form>
            </CardContent>
          </Card>

          <p className="text-sm text-muted-foreground">
            Missing a repository?{" "}
            <a
              href={github.installUrl}
              className="font-medium underline underline-offset-4"
            >
              Install the GitHub App on another organization
            </a>{" "}
            or grant it access to more repos.
          </p>
        </div>
      )}
    </AppShell>
  );
}
