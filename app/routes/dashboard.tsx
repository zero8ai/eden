import { authkitLoader, signOut } from "@workos-inc/authkit-react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Link } from "react-router";

import { AppShell, PageHeader } from "~/components/shell";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { listProjects } from "~/db/queries.server";
import { syncTenant } from "~/auth/tenant.server";
import { ensureWorkspace } from "~/auth/workspace.server";
import type { Route } from "./+types/dashboard";

// `ensureSignedIn: true` redirects anonymous visitors to WorkOS sign-in. The inner
// loader only runs for authenticated users, so `auth` is always populated here.
export const loader = (args: LoaderFunctionArgs) =>
  authkitLoader(
    args,
    async ({ auth }) => {
      // First org-less login: provision the user's workspace and replay (redirect).
      await ensureWorkspace(args.request, auth);
      const { org } = await syncTenant(auth);
      const projects = org ? await listProjects(org.id) : [];
      return { org, projects };
    },
    { ensureSignedIn: true },
  );

export async function action({ request }: ActionFunctionArgs) {
  return await signOut(request);
}

export function meta() {
  return [{ title: "Agents · Eden" }];
}

export default function Dashboard({ loaderData }: Route.ComponentProps) {
  const { user, org, projects } = loaderData;

  return (
    <AppShell workspaceName={org?.name} userEmail={user.email}>
      <PageHeader
        title="Agents"
        description="Each agent is an eve repository — its instructions, tools, and subagents live in git."
        actions={
          <Button asChild>
            <Link to="/connect">New agent</Link>
          </Button>
        }
      />

      {projects.length === 0 ? (
        <Card className="border-dashed">
          <CardHeader className="items-center py-12 text-center">
            <CardTitle className="text-lg">No agents yet</CardTitle>
            <CardDescription>
              Connect an existing eve repository or create a new one to get started.
            </CardDescription>
            <Button asChild className="mt-4">
              <Link to="/connect">Connect a repository</Link>
            </Button>
          </CardHeader>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {projects.map((p) => (
            <Link key={p.id} to={`/projects/${p.id}`} className="group">
              <Card className="h-full transition-colors group-hover:border-ring/60">
                <CardHeader>
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle className="truncate text-base">{p.name}</CardTitle>
                    {p.repoOwner ? (
                      <Badge variant="secondary" className="shrink-0 font-mono text-xs">
                        {p.repoOwner}/{p.repoName}
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="shrink-0">
                        no repo
                      </Badge>
                    )}
                  </div>
                  <CardDescription>
                    Default branch{" "}
                    <span className="font-mono">{p.defaultBranch}</span>
                  </CardDescription>
                </CardHeader>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </AppShell>
  );
}
