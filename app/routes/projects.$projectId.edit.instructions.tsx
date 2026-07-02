/**
 * Structured editor: agent instructions (Author pillar, M1).
 *
 * Save STAGES the edit as a draft (refresh-proof, no git write); publishing the staged
 * change-set into a PR happens on the Changes tab (PRD §7.3: edits accumulate; publish opens
 * the PR). The loader overlays any staged draft over the repo content.
 */
import { authkitLoader, withAuth } from "@workos-inc/authkit-react-router";
import {
  Form,
  Link,
  data,
  redirect,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { AgentNav, AppShell, PageHeader } from "~/components/shell";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { syncTenant } from "~/auth/tenant.server";
import { getProject } from "~/db/queries.server";
import { getDraft, stageDraft } from "~/drafts/drafts.server";
import { readAgentFile } from "~/github/repo.server";
import type { Route } from "./+types/projects.$projectId.edit.instructions";

const INSTRUCTIONS_PATH = "agent/instructions.md";

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

      // Overlay a staged draft (unpublished edit) over the repo content.
      const [repoContent, draft] = await Promise.all([
        readAgentFile(
          project.repoInstallationId,
          { owner: project.repoOwner, repo: project.repoName },
          INSTRUCTIONS_PATH,
        ),
        getDraft(project.id, INSTRUCTIONS_PATH),
      ]);

      return {
        project,
        instructions: draft?.content ?? repoContent ?? "",
        hasDraft: !!draft,
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

  try {
    await stageDraft({
      projectId: project.id,
      path: INSTRUCTIONS_PATH,
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
  const { project, instructions, hasDraft } = loaderData;
  const navigation = useNavigation();
  const saving = navigation.state === "submitting";

  const base = `/projects/${project.id}`;

  return (
    <AppShell>
      <PageHeader
        title="Edit instructions"
        description="Saving stages the change — publish staged changes as one pull request from the Changes tab."
      />
      <AgentNav base={base} />

      {actionData?.error && (
        <Alert variant="destructive" className="mb-6">
          <AlertTitle>Couldn&rsquo;t stage the change</AlertTitle>
          <AlertDescription>{actionData.error}</AlertDescription>
        </Alert>
      )}

      {(actionData?.ok || hasDraft) && (
        <Alert className="mb-6">
          <AlertTitle>Staged — not published yet</AlertTitle>
          <AlertDescription className="flex items-center gap-3">
            <span>This file has an unpublished draft.</span>
            <Link
              to={`${base}/changes`}
              className="font-medium underline underline-offset-4"
            >
              Review &amp; publish in Changes →
            </Link>
          </AlertDescription>
        </Alert>
      )}

      <Form method="post">
        <Textarea
          name="content"
          defaultValue={instructions}
          spellCheck={false}
          className="min-h-[28rem] font-mono text-sm"
        />
        <div className="mt-4 flex items-center gap-3">
          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
          <Button variant="ghost" asChild>
            <Link to={base}>Cancel</Link>
          </Button>
        </div>
      </Form>
    </AppShell>
  );
}
