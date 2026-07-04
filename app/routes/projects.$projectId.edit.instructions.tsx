/**
 * Structured editor: agent instructions (Author pillar, M1).
 *
 * Save STAGES the edit as a draft (refresh-proof, no git write); publishing the staged
 * change-set into a PR happens on the Changes tab (PRD §7.3: edits accumulate; publish opens
 * the PR). The loader overlays any staged draft over the repo content.
 */
import { authkitLoader, withAuth } from "@workos-inc/authkit-react-router";
import { useState } from "react";
import {
  Link,
  data,
  redirect,
  useNavigation,
  useSubmit,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { CodeEditor } from "~/components/code-editor";
import { FileStateBanner } from "~/components/file-state-banner";
import { AgentNav, AppShell, PageHeader, repoCrumbs } from "~/components/shell";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { syncTenant } from "~/auth/tenant.server";
import { getProject } from "~/db/queries.server";
import { resolveFileView, stageDraft } from "~/drafts/drafts.server";
import { agentParam, resolveAgentContext } from "~/project/agent-context.server";
import type { Route } from "./+types/projects.$projectId.edit.instructions";

export const loader = (args: LoaderFunctionArgs) =>
  authkitLoader(
    args,
    async ({ auth }) => {
      const { org } = await syncTenant({
        user: auth.user,
        organizationId: auth.organizationId,
        role: auth.role,
      });
      if (!org) throw data("No organization", { status: 403 });

      const project = await getProject(org.id, args.params.projectId!);
      if (!project) throw data("Project not found", { status: 404 });
      if (!project.repoInstallationId || !project.repoOwner || !project.repoName) {
        throw data("Project has no connected repo", { status: 400 });
      }

      const { roster, active, isTeam } = await resolveAgentContext(
        project.id,
        agentParam(args.request),
      );
      const path = `${active.root}/instructions.md`;

      // Show the latest intended value: staged draft → open change request → repo.
      const view = await resolveFileView(
        {
          id: project.id,
          repoInstallationId: project.repoInstallationId,
          repoOwner: project.repoOwner,
          repoName: project.repoName,
        },
        path,
      );

      return {
        project,
        path,
        roster: roster.map((a) => ({ name: a.name })),
        activeAgent: active.name,
        isTeam,
        instructions: view.content ?? "",
        source: view.source,
        change: view.change,
      };
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
  if (!org) return { error: "You must belong to an organization." };

  const project = await getProject(org.id, args.params.projectId!);
  if (!project?.repoInstallationId || !project.repoOwner || !project.repoName) {
    return { error: "Project has no connected repo." };
  }

  const form = await args.request.formData();
  const content = String(form.get("content") ?? "");
  const { active } = await resolveAgentContext(
    project.id,
    String(form.get("agent") ?? "") || null,
  );

  try {
    await stageDraft({
      projectId: project.id,
      path: `${active.root}/instructions.md`,
      content,
      createdBy: auth.user.id,
    });
    return { ok: true as const };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

export function meta() {
  return [{ title: "Edit instructions · Eden" }];
}

export default function EditInstructions({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { project, path, roster, activeAgent, isTeam, instructions, source, change } =
    loaderData;
  const navigation = useNavigation();
  const submit = useSubmit();
  const saving = navigation.state !== "idle";
  const [value, setValue] = useState(instructions);

  const base = `/repos/${project.id}`;
  const backTo = isTeam ? `${base}?agent=${encodeURIComponent(activeAgent)}` : base;

  return (
    <AppShell breadcrumbs={repoCrumbs({ projectId: project.id, repoName: project.name, isTeam: roster.length > 1, agentName: activeAgent, tail: [{ label: "Instructions" }] })}>
      <PageHeader
        title={isTeam ? `Edit instructions — ${activeAgent}` : "Edit instructions"}
        description="Saving stages the change — publish staged changes as one pull request from the Changes tab."
      />
      <AgentNav base={base} roster={roster} activeAgent={activeAgent} />

      {actionData?.error && (
        <Alert variant="destructive" className="mb-6">
          <AlertTitle>Couldn&rsquo;t stage the change</AlertTitle>
          <AlertDescription>{actionData.error}</AlertDescription>
        </Alert>
      )}

      <FileStateBanner
        saved={!!actionData?.ok}
        source={source}
        change={change}
        base={base}
      />

      <CodeEditor path={path} value={value} onChange={setValue} />
      <div className="mt-4 flex items-center gap-3">
        <Button
          onClick={() =>
            submit({ content: value, agent: activeAgent }, { method: "post" })
          }
          disabled={saving}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
        <Button variant="ghost" asChild>
          <Link to={backTo}>Cancel</Link>
        </Button>
      </div>
    </AppShell>
  );
}
