/**
 * Structured editor: agent instructions (Author pillar, M1).
 *
 * The simplest editor, and the proof of the git-native write flow (D3): load the current
 * `agent/instructions.md`, edit it, and Save opens a PR via `proposeChange`. Eden never writes
 * the default branch directly — the human merges the PR to ship.
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
import { readAgentFile } from "~/github/repo.server";
import { proposeChange } from "~/github/write.server";
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

      const instructions =
        (await readAgentFile(
          project.repoInstallationId,
          { owner: project.repoOwner, repo: project.repoName },
          INSTRUCTIONS_PATH,
        )) ?? "";

      return { project, instructions };
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
    const change = await proposeChange(
      project.repoInstallationId,
      { owner: project.repoOwner, repo: project.repoName },
      {
        branch: `eden/instructions-${Date.now().toString(36)}`,
        files: [{ path: INSTRUCTIONS_PATH, content }],
        title: "Update agent instructions",
        body: "Edited via Eden.",
        commitMessage: "chore(agent): update instructions",
      },
    );
    return {
      ok: true as const,
      pullRequestUrl: change.pullRequestUrl,
      pullRequestNumber: change.pullRequestNumber,
    };
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
  const { project, instructions } = loaderData;
  const navigation = useNavigation();
  const saving = navigation.state === "submitting";

  const base = `/projects/${project.id}`;

  return (
    <AppShell>
      <PageHeader
        title="Edit instructions"
        description={
          <>
            Saving opens a pull request against{" "}
            <span className="font-mono">{project.defaultBranch}</span>. Merge it
            to ship.
          </>
        }
      />
      <AgentNav base={base} />

      {actionData?.error && (
        <Alert variant="destructive" className="mb-6">
          <AlertTitle>Couldn&rsquo;t open the pull request</AlertTitle>
          <AlertDescription>{actionData.error}</AlertDescription>
        </Alert>
      )}

      {actionData?.ok && (
        <Alert className="mb-6">
          <AlertTitle>Pull request opened</AlertTitle>
          <AlertDescription>
            <a
              className="font-medium underline underline-offset-4"
              href={actionData.pullRequestUrl}
              target="_blank"
              rel="noreferrer"
            >
              #{actionData.pullRequestNumber}
            </a>
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
            {saving ? "Opening PR…" : "Save as pull request"}
          </Button>
          <Button variant="ghost" asChild>
            <Link to={base}>Cancel</Link>
          </Button>
        </div>
      </Form>
    </AppShell>
  );
}
