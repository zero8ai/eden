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
import {
  authkitLoader,
  withAuth,
} from "@workos-inc/authkit-react-router";
import {
  Form,
  Link,
  redirect,
  useNavigation,
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
import { createProject } from "~/db/queries.server";
import { syncTenant, type Org } from "~/auth/tenant.server";
import { ensureWorkspace } from "~/auth/workspace.server";
import { getInstallUrl } from "~/github/client.server";
import { createEveRepo } from "~/github/create.server";
import {
  fetchAgentSource,
  listInstallationRepos,
  type InstallationRepo,
} from "~/github/repo.server";
import { isEveRepo } from "~/eve/parse";
import type { Route } from "./+types/connect";

type GithubConnectState =
  | { state: "no-org" }
  | { state: "install"; installUrl: string }
  | { state: "pick"; installationId: string; repos: InstallationRepo[] }
  | { state: "unconfigured"; message: string };

interface ConnectView {
  org: Org | null;
  github: GithubConnectState;
}

export const loader = (args: LoaderFunctionArgs) =>
  authkitLoader(
    args,
    async ({ auth }): Promise<ConnectView> => {
      // First org-less login: provision the user's workspace and replay (redirect).
      await ensureWorkspace(args.request, auth);
      const { org } = await syncTenant({
        user: auth.user,
        organizationId: auth.organizationId,
        role: auth.role,
      });
      if (!org) return { org: null, github: { state: "no-org" as const } };

      const url = new URL(args.request.url);
      const installationId = url.searchParams.get("installation_id");

      try {
        if (installationId) {
          const repos = await listInstallationRepos(installationId);
          return {
            org,
            github: { state: "pick" as const, installationId, repos },
          };
        }
        return {
          org,
          github: { state: "install" as const, installUrl: getInstallUrl(org.id) },
        };
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

export async function action(args: ActionFunctionArgs) {
  const auth = await withAuth(args);
  if (!auth.user) throw redirect("/login");

  const { org } = await syncTenant({
    user: auth.user,
    organizationId: auth.organizationId ?? null,
    role: auth.role ?? null,
  });
  if (!org) return { error: "You must belong to an organization to connect a repo." };

  const form = await args.request.formData();
  const installationId = String(form.get("installationId") ?? "");
  if (!installationId) return { error: "Missing installation." };
  const intent = String(form.get("intent") ?? "connect");

  // ── Create a new repo + scaffold (eve init) ──
  if (intent === "create") {
    const owner = String(form.get("owner") ?? "").trim();
    const name = String(form.get("name") ?? "").trim();
    if (!owner || !name) return { error: "Owner and repo name are required." };
    try {
      const repo = await createEveRepo(installationId, { owner, name });
      const project = await createProject({
        orgId: org.id,
        name,
        repoOwner: repo.owner,
        repoName: repo.repo,
        repoInstallationId: installationId,
        defaultBranch: repo.defaultBranch,
      });
      throw redirect(`/projects/${project.id}`);
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
    return { error: `Could not read ${owner}/${repo}: ${(error as Error).message}` };
  }
  if (!isEveRepo(source.paths)) {
    return {
      error: `${owner}/${repo} doesn't look like an eve project — no \`agent/\` directory found.`,
    };
  }

  const project = await createProject({
    orgId: org.id,
    name: repo,
    repoOwner: owner,
    repoName: repo,
    repoInstallationId: installationId,
    defaultBranch: source.ref || defaultBranch,
  });

  throw redirect(`/projects/${project.id}`);
}

export function meta() {
  return [{ title: "Connect a repo · Eden" }];
}

export default function Connect({ loaderData, actionData }: Route.ComponentProps) {
  const { org, github } = loaderData;
  const navigation = useNavigation();
  const submitting = navigation.state === "submitting";

  return (
    <AppShell workspaceName={org?.name}>
      <PageHeader
        title="New agent"
        description="An agent is one eve repository. Connect an existing repo, or scaffold a fresh one."
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
            <CardTitle>Install the GitHub App</CardTitle>
            <CardDescription>
              Install Eden on the account that owns your eve repository, then pick
              the repo to connect. You control which repositories it can access.
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
              <CardTitle>Connect an existing repository</CardTitle>
              <CardDescription>
                Repositories the GitHub App can access. Eden validates that the
                repo is an eve project before connecting.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {github.repos.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No repositories are accessible to this installation. Grant the
                  App access to your eve repo and try again.
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
                        <input type="hidden" name="installationId" value={github.installationId} />
                        <input type="hidden" name="owner" value={r.owner} />
                        <input type="hidden" name="repo" value={r.repo} />
                        <input type="hidden" name="defaultBranch" value={r.defaultBranch} />
                        <Button size="sm" variant="secondary" type="submit" disabled={submitting}>
                          {submitting ? "Connecting…" : "Connect"}
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
              <CardTitle>Create a new eve agent</CardTitle>
              <CardDescription>
                Creates a repository in your organization and scaffolds an eve{" "}
                <span className="font-mono">agent/</span> skeleton.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Form method="post" className="flex flex-wrap items-end gap-3">
                <input type="hidden" name="intent" value="create" />
                <input type="hidden" name="installationId" value={github.installationId} />
                <div className="grid gap-1.5">
                  <Label htmlFor="owner">Organization</Label>
                  <Input
                    id="owner"
                    name="owner"
                    defaultValue={github.repos[0]?.owner ?? ""}
                    placeholder="org"
                    className="w-40"
                  />
                </div>
                <span className="pb-2 text-muted-foreground">/</span>
                <div className="grid gap-1.5">
                  <Label htmlFor="name">Repository</Label>
                  <Input
                    id="name"
                    name="name"
                    placeholder="my-agent"
                    className="w-56 font-mono"
                  />
                </div>
                <Button type="submit" disabled={submitting}>
                  {submitting ? "Creating…" : "Create & scaffold"}
                </Button>
              </Form>
            </CardContent>
          </Card>
        </div>
      )}
    </AppShell>
  );
}
