/**
 * Structured editor: agent runtime config (`agent/agent.ts`) — Author pillar, M1.
 *
 * A form over the `defineAgent({...})` config (model to start; more options later). Save
 * rewrites `agent.ts` with a targeted edit and STAGES it as a draft; the Changes tab publishes
 * staged drafts as one PR (PRD §7.3). If `agent.ts` doesn't exist, we scaffold a minimal one.
 * The loader overlays a staged draft so the form reflects unpublished edits.
 */
import { authkitLoader, withAuth } from "@workos-inc/authkit-react-router";
import {
  Form,
  Link,
  redirect,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { AgentNav, AppShell, PageHeader } from "~/components/shell";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import { getDraft, stageDraft } from "~/drafts/drafts.server";
import { readModel, scaffoldAgentModule, setModel, SUGGESTED_MODELS } from "~/eve/agentModule";
import { readAgentFile } from "~/github/repo.server";
import { requireProject, requireRepo } from "~/project/guard.server";
import type { Route } from "./+types/projects.$projectId.edit.agent";

const AGENT_PATH = "agent/agent.ts";

export const loader = (args: LoaderFunctionArgs) =>
  authkitLoader(
    args,
    async ({ auth }) => {
      const project = requireRepo(
        await requireProject(
          {
            user: auth.user,
            organizationId: auth.organizationId,
            role: auth.role,
          },
          args.params.projectId,
        ),
      );
      // Overlay a staged draft (unpublished edit) over the repo content.
      const [repoSource, draft] = await Promise.all([
        readAgentFile(
          project.repoInstallationId,
          { owner: project.repoOwner, repo: project.repoName },
          AGENT_PATH,
        ),
        getDraft(project.id, AGENT_PATH),
      ]);
      const source = draft?.content ?? repoSource;
      return {
        project,
        model: source ? readModel(source) : null,
        exists: repoSource !== null,
        hasDraft: !!draft,
      };
    },
    { ensureSignedIn: true },
  );

export async function action(args: ActionFunctionArgs) {
  const auth = await withAuth(args);
  if (!auth.user) throw redirect("/login");
  const project = requireRepo(
    await requireProject(
      {
        user: auth.user,
        organizationId: auth.organizationId ?? null,
        role: auth.role ?? null,
      },
      args.params.projectId,
    ),
  );

  const form = await args.request.formData();
  const selected = String(form.get("model") ?? "").trim();
  const model =
    selected === "__custom"
      ? String(form.get("customModel") ?? "").trim()
      : selected;
  if (!model) return { error: "Pick or enter a model." };

  // Base the targeted edit on the staged draft if one exists (edits stack), else the repo.
  const [repoSource, draft] = await Promise.all([
    readAgentFile(
      project.repoInstallationId,
      { owner: project.repoOwner, repo: project.repoName },
      AGENT_PATH,
    ),
    getDraft(project.id, AGENT_PATH),
  ]);
  const current = draft?.content ?? repoSource;
  const next = current ? setModel(current, model) : scaffoldAgentModule(model);

  try {
    await stageDraft({
      projectId: project.id,
      path: AGENT_PATH,
      content: next,
      createdBy: auth.user.id,
    });
    return { ok: true as const };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

export function meta() {
  return [{ title: "Runtime config · Eden" }];
}

export default function EditAgent({ loaderData, actionData }: Route.ComponentProps) {
  const { project, model, exists, hasDraft } = loaderData;
  const navigation = useNavigation();
  const saving = navigation.state === "submitting";
  const current = model ?? "";
  const knownSelected = SUGGESTED_MODELS.includes(
    current as (typeof SUGGESTED_MODELS)[number],
  );

  const base = `/projects/${project.id}`;

  return (
    <AppShell>
      <PageHeader
        title="Agent config"
        description={
          <>
            {exists ? (
              <>
                Editing <span className="font-mono">agent/agent.ts</span>.
              </>
            ) : (
              <>
                No <span className="font-mono">agent/agent.ts</span> yet — saving
                scaffolds one.
              </>
            )}{" "}
            Saving stages the change — publish from the Changes tab.
          </>
        }
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

      <Form method="post" className="max-w-xl space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="model">Model</Label>
          <select
            id="model"
            name="model"
            defaultValue={knownSelected ? current : "__custom"}
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onChange={(e) => {
              const custom = e.currentTarget.form?.elements.namedItem(
                "customModel",
              ) as HTMLInputElement | null;
              if (custom) custom.hidden = e.currentTarget.value !== "__custom";
            }}
          >
            {SUGGESTED_MODELS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
            <option value="__custom">Custom…</option>
          </select>
          <input
            name="customModel"
            defaultValue={knownSelected ? "" : current}
            hidden={knownSelected}
            placeholder="provider/model-id"
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 font-mono text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          <p className="text-xs text-muted-foreground">
            Provider-prefixed, e.g.{" "}
            <span className="font-mono">anthropic/claude-sonnet-5</span>.
          </p>
        </div>

        <div className="flex items-center gap-3">
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
