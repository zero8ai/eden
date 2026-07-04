import { authkitLoader, signOut } from "@workos-inc/authkit-react-router";
import { Users } from "lucide-react";
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
import { listAgents, listProjects, type Project } from "~/db/queries.server";
import { syncTenant } from "~/auth/tenant.server";
import { ensureWorkspace } from "~/auth/workspace.server";
import type { Route } from "./+types/dashboard";

/** A project annotated with its roster, so the dashboard can split teams from agents. */
interface ProjectCard {
  project: Project;
  /** Member names; `isTeam` when the repo uses the agents/* layout (PRD §7.9). */
  members: string[];
  isTeam: boolean;
}

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
      const cards: ProjectCard[] = await Promise.all(
        projects.map(async (project) => {
          const roster = await listAgents(project.id);
          return {
            project,
            members: roster.map((a) => a.name),
            isTeam: roster.length > 0 && roster[0].root !== "agent",
          };
        }),
      );
      return { org, cards };
    },
    { ensureSignedIn: true },
  );

export async function action({ request }: ActionFunctionArgs) {
  return await signOut(request);
}

export function meta() {
  return [{ title: "Repositories · Eden" }];
}

export default function Dashboard({ loaderData }: Route.ComponentProps) {
  const { user, org, cards } = loaderData;
  const teams = cards.filter((c) => c.isTeam);
  const singles = cards.filter((c) => !c.isTeam);

  return (
    <AppShell workspaceName={org?.name} userEmail={user.email}>
      <PageHeader
        title="Repositories"
        description="A repository holds one agent, or a team of agents that work together."
        actions={
          <Button asChild>
            <Link to="/connect">New repository</Link>
          </Button>
        }
      />

      {cards.length === 0 ? (
        <Card className="border-dashed">
          <CardHeader className="items-center py-12 text-center">
            <CardTitle className="text-lg">No repositories yet</CardTitle>
            <CardDescription>
              Connect an existing eve repository or create a new one to get started.
            </CardDescription>
            <Button asChild className="mt-4">
              <Link to="/connect">Connect a repository</Link>
            </Button>
          </CardHeader>
        </Card>
      ) : (
        <div className="space-y-8">
          {teams.length > 0 && (
            <section>
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-muted-foreground">
                <Users className="h-4 w-4" aria-hidden /> Teams
              </h2>
              <div className="grid gap-4 sm:grid-cols-2">
                {teams.map((c) => (
                  <TeamCard key={c.project.id} card={c} />
                ))}
              </div>
            </section>
          )}
          {singles.length > 0 && (
            <section>
              {teams.length > 0 && (
                <h2 className="mb-3 text-sm font-semibold text-muted-foreground">
                  Agents
                </h2>
              )}
              <div className="grid gap-4 sm:grid-cols-2">
                {singles.map((c) => (
                  <AgentCard key={c.project.id} project={c.project} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </AppShell>
  );
}

/** A team: its roster is the headline — members are the thing you manage. */
function TeamCard({ card }: { card: ProjectCard }) {
  const { project, members } = card;
  return (
    <Link to={`/repos/${project.id}`} className="group">
      <Card className="h-full border-primary/20 transition-colors group-hover:border-ring/60">
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2 truncate text-base">
              <Users className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              {project.name}
            </CardTitle>
            <Badge className="shrink-0">
              Team · {members.length} member{members.length === 1 ? "" : "s"}
            </Badge>
          </div>
          <CardDescription className="truncate">
            <span className="font-mono">
              {members.slice(0, 4).join(" · ")}
              {members.length > 4 ? ` · +${members.length - 4}` : ""}
            </span>
          </CardDescription>
        </CardHeader>
      </Card>
    </Link>
  );
}

function AgentCard({ project }: { project: Project }) {
  return (
    <Link to={`/repos/${project.id}`} className="group">
      <Card className="h-full transition-colors group-hover:border-ring/60">
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="truncate text-base">{project.name}</CardTitle>
            {project.repoOwner ? (
              <Badge variant="secondary" className="shrink-0 font-mono text-xs">
                {project.repoOwner}/{project.repoName}
              </Badge>
            ) : (
              <Badge variant="outline" className="shrink-0">
                no repo
              </Badge>
            )}
          </div>
          <CardDescription>
            Default branch <span className="font-mono">{project.defaultBranch}</span>
          </CardDescription>
        </CardHeader>
      </Card>
    </Link>
  );
}
