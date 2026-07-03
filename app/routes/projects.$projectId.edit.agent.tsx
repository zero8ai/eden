/**
 * Structured editor: agent runtime config (`agent/agent.ts`) — Author pillar, M1.
 *
 * A form over the `defineAgent({...})` config (model to start; more options later). Save
 * rewrites `agent.ts` with a targeted edit and STAGES it as a draft; the Changes tab publishes
 * staged drafts as one PR (PRD §7.3). If `agent.ts` doesn't exist, we scaffold a minimal one.
 * The loader overlays a staged draft so the form reflects unpublished edits.
 */
import { authkitLoader, withAuth } from "@workos-inc/authkit-react-router";
import { useState } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Input } from "~/components/ui/input";
import { FileStateBanner } from "~/components/file-state-banner";
import { resolveFileView, stageDraft } from "~/drafts/drafts.server";
import { readModel, scaffoldAgentModule, setModel, SUGGESTED_MODELS } from "~/eve/agentModule";
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
      // Show the latest intended value: staged draft → open change request → repo.
      const view = await resolveFileView(project, AGENT_PATH);
      return {
        project,
        model: view.content ? readModel(view.content) : null,
        exists: view.content !== null,
        source: view.source,
        change: view.change,
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

  // Base the targeted edit on the latest intended value (draft → pending change → repo) so
  // saving the model never silently reverts other unmerged edits to this file.
  const view = await resolveFileView(project, AGENT_PATH);
  const next = view.content ? setModel(view.content, model) : scaffoldAgentModule(model);

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
  const { project, model, exists, source, change } = loaderData;
  const navigation = useNavigation();
  const saving = navigation.state === "submitting";
  const current = model ?? "";
  const knownSelected = SUGGESTED_MODELS.includes(
    current as (typeof SUGGESTED_MODELS)[number],
  );
  const [selected, setSelected] = useState(knownSelected ? current : "__custom");

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
      <FileStateBanner
        saved={!!actionData?.ok}
        source={source}
        change={change}
        base={base}
      />

      <Form method="post" className="max-w-xl space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="model">Model</Label>
          <Select name="model" value={selected} onValueChange={setSelected}>
            <SelectTrigger id="model" className="w-full">
              <SelectValue placeholder="Pick a model" />
            </SelectTrigger>
            <SelectContent>
              {SUGGESTED_MODELS.map((m) => (
                <SelectItem key={m} value={m}>
                  {m}
                </SelectItem>
              ))}
              <SelectItem value="__custom">Custom…</SelectItem>
            </SelectContent>
          </Select>
          {selected === "__custom" && (
            <Input
              name="customModel"
              aria-label="Custom model id"
              defaultValue={knownSelected ? "" : current}
              placeholder="provider/model-id"
              className="font-mono"
            />
          )}
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
