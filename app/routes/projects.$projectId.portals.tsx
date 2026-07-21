/**
 * Portals admin — index (issue #180): every portal publishing one of this repo's agents, plus
 * the create form. Detail management (access list, model pin, limits, transcripts) lives on
 * the per-portal page.
 */
import { Globe } from "lucide-react";
import {
  Form,
  Link,
  redirect,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { getSessionAuth, sessionLoader } from "~/auth/session.server";
import { AgentNav, AppShell, PageHeader, repoCrumbs } from "~/components/shell";
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
import { contextPath } from "~/lib/paths";
import { createPortal, listProjectPortals } from "~/portal/portals.server";
import { resolveAgentContext } from "~/project/agent-context.server";
import { requireProject, requireRepo } from "~/project/guard.server";
import type { Route } from "./+types/projects.$projectId.portals";

export const loader = (args: LoaderFunctionArgs) =>
  sessionLoader(
    args,
    async ({ auth }) => {
      const project = requireRepo(
        await requireProject(auth, args.params.projectId, {
          request: args.request,
        }),
      );
      const { roster, isTeam } = await resolveAgentContext(project.id, null);
      const portals = await listProjectPortals(project.id);
      const agentNames = new Map(roster.map((a) => [a.id, a.name]));
      return {
        project: { id: project.id, name: project.name },
        isTeam,
        roster: roster.map((a) => ({ id: a.id, name: a.name })),
        portals: portals.map((p) => ({
          id: p.id,
          slug: p.slug,
          name: p.name,
          agentName: agentNames.get(p.agentId) ?? null,
          disabled: p.disabledAt !== null,
          grantCount: p.grantCount,
          sessionCount: p.sessionCount,
        })),
      };
    },
    { ensureSignedIn: true },
  );

export async function action(args: ActionFunctionArgs) {
  const auth = await getSessionAuth(args);
  if (!auth.user) throw redirect("/login");
  const project = requireRepo(
    await requireProject(auth, args.params.projectId),
  );
  const form = await args.request.formData();
  if (String(form.get("intent")) === "create-portal") {
    const name = String(form.get("name") ?? "").trim();
    if (!name) return { error: "Give the portal a name." };
    const { roster } = await resolveAgentContext(project.id, null);
    const requestedAgentId = String(form.get("agentId") ?? "");
    const agent =
      roster.find((a) => a.id === requestedAgentId) ?? roster[0] ?? null;
    if (!agent) return { error: "This repository has no agents." };
    const portal = await createPortal({
      projectId: project.id,
      agentId: agent.id,
      name,
      createdBy: auth.user.id,
    });
    throw redirect(`/repos/${project.id}/portals/${portal.id}`);
  }
  return { ok: true as const };
}

export function meta() {
  return [{ title: "Portals · eden" }];
}

export default function Portals({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { project, isTeam, roster, portals } = loaderData;
  const base = contextPath(project.id, null);

  return (
    <AppShell
      breadcrumbs={repoCrumbs({
        projectId: project.id,
        repoName: project.name,
        isTeam,
        tail: [{ label: "Portals" }],
      })}
    >
      <div className="mx-auto w-full max-w-5xl px-4 pt-8 sm:px-6">
        <AgentNav base={base} level={isTeam ? "repo" : "single"} />
        <PageHeader
          icon={Globe}
          accent="emerald"
          title="Portals"
          description="Publish an agent to a minimal chat page for people outside this workspace. Guests sign in with an emailed one-time code — no account, no org membership."
        />

        <div className="space-y-4">
          {portals.map((portal) => (
            <Card key={portal.id}>
              <CardContent className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{portal.name}</span>
                    {portal.disabled && (
                      <Badge variant="secondary">Disabled</Badge>
                    )}
                    {isTeam && portal.agentName && (
                      <Badge variant="outline">{portal.agentName}</Badge>
                    )}
                  </div>
                  <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                    /a/{portal.slug}
                  </p>
                </div>
                <div className="flex items-center gap-4">
                  <span className="text-xs text-muted-foreground">
                    {portal.grantCount} invited · {portal.sessionCount}{" "}
                    conversation{portal.sessionCount === 1 ? "" : "s"}
                  </span>
                  <Button asChild variant="outline" size="sm">
                    <Link to={`${base}/portals/${portal.id}`}>Manage</Link>
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
          {portals.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No portals yet — create one below to share this agent outside the
              workspace.
            </p>
          )}
        </div>

        <Card className="mb-16 mt-8">
          <CardHeader>
            <CardTitle className="text-base">Create a portal</CardTitle>
            <CardDescription>
              The portal gets an unguessable URL; only emails you invite can
              sign in.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Form method="post" className="flex flex-wrap items-end gap-3">
              <input type="hidden" name="intent" value="create-portal" />
              <div className="min-w-56 space-y-2">
                <Label htmlFor="portal-name">Name</Label>
                <Input
                  id="portal-name"
                  name="name"
                  placeholder="e.g. Billing assistant"
                  required
                />
              </div>
              {isTeam && (
                <div className="space-y-2">
                  <Label htmlFor="portal-agent">Agent</Label>
                  <select
                    id="portal-agent"
                    name="agentId"
                    className="h-9 rounded-md border bg-background px-2 text-sm"
                  >
                    {roster.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <Button type="submit">Create portal</Button>
              {actionData && "error" in actionData && actionData.error && (
                <p className="text-sm text-destructive">{actionData.error}</p>
              )}
            </Form>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
