/**
 * Embedded authoring assistant (Author pillar, M1 — PRD §7.2).
 *
 * A PM describes a tool; the assistant generates the `defineTool` TypeScript, explains it, and
 * lists any secrets it needs. "Save" ships the generated file through the PR flow (D3). Two
 * intents: `generate` (produce + preview) and `save` (open the PR).
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
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Textarea } from "~/components/ui/textarea";
import { getAuthoringAssistant } from "~/assistant/index.server";
import { stageDraft } from "~/drafts/drafts.server";
import { requireProject, requireRepo } from "~/project/guard.server";
import type { Route } from "./+types/projects.$projectId.assistant";

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
      return { project };
    },
    { ensureSignedIn: true },
  );

type ActionResult =
  | { kind: "generated"; path: string; content: string; explanation: string; secretsNeeded: string[] }
  | { kind: "saved"; path: string }
  | { kind: "error"; message: string };

export async function action(args: ActionFunctionArgs): Promise<ActionResult> {
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
  const intent = String(form.get("intent") ?? "generate");

  if (intent === "save") {
    const path = String(form.get("path") ?? "");
    const content = String(form.get("content") ?? "");
    if (!path || !content) return { kind: "error", message: "Nothing to save." };
    try {
      // Stage like every other editor: the Changes tab publishes staged drafts as one PR.
      await stageDraft({
        projectId: project.id,
        path,
        content,
        createdBy: auth.user.id,
      });
      return { kind: "saved", path };
    } catch (error) {
      return { kind: "error", message: (error as Error).message };
    }
  }

  const instruction = String(form.get("instruction") ?? "").trim();
  if (!instruction) return { kind: "error", message: "Describe the tool you want." };
  try {
    const tool = await getAuthoringAssistant().generateTool({ instruction });
    return {
      kind: "generated",
      path: tool.path,
      content: tool.content,
      explanation: tool.explanation,
      secretsNeeded: tool.secretsNeeded,
    };
  } catch (error) {
    return { kind: "error", message: (error as Error).message };
  }
}

export function meta() {
  return [{ title: "Assistant · Eden" }];
}

export default function Assistant({ loaderData, actionData }: Route.ComponentProps) {
  const { project } = loaderData;
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";
  const generated = actionData?.kind === "generated" ? actionData : null;

  const base = `/projects/${project.id}`;

  return (
    <AppShell workspaceName={project.name}>
      <PageHeader
        title="Authoring assistant"
        description="Describe a tool in plain language. The assistant writes the TypeScript; you review it and open a pull request."
        actions={
          <Button variant="outline" asChild>
            <Link to={base}>← {project.name}</Link>
          </Button>
        }
      />
      <AgentNav base={base} />

      {actionData?.kind === "error" && (
        <Alert variant="destructive" className="mb-6">
          <AlertDescription>{actionData.message}</AlertDescription>
        </Alert>
      )}
      {actionData?.kind === "saved" && (
        <Alert className="mb-6">
          <AlertTitle>
            Staged <span className="font-mono">{actionData.path}</span>
          </AlertTitle>
          <AlertDescription>
            <Link
              to={`${base}/changes`}
              className="font-medium underline underline-offset-4"
            >
              Review &amp; publish in Changes →
            </Link>
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Describe a tool</CardTitle>
        </CardHeader>
        <CardContent>
          <Form method="post">
            <input type="hidden" name="intent" value="generate" />
            <Textarea
              name="instruction"
              rows={3}
              placeholder="e.g. Look up an order by ID in our Postgres and return its status."
            />
            <Button type="submit" disabled={busy} className="mt-3">
              {busy ? "Generating…" : "Generate tool"}
            </Button>
          </Form>
        </CardContent>
      </Card>

      {generated && (
        <section className="mt-8 space-y-3">
          <Alert>
            <AlertDescription>
              {generated.explanation}
              {generated.secretsNeeded.length > 0 && (
                <p className="mt-2">
                  Secrets needed:{" "}
                  {generated.secretsNeeded.map((s) => (
                    <Badge key={s} variant="secondary" className="mr-1 font-mono">
                      {s}
                    </Badge>
                  ))}
                  —{" "}
                  <Link className="underline" to={`/projects/${project.id}/secrets`}>
                    set them
                  </Link>
                  .
                </p>
              )}
            </AlertDescription>
          </Alert>

          <div className="text-xs font-medium text-muted-foreground">
            {generated.path}
          </div>
          <pre className="max-h-96 overflow-auto rounded-xl border bg-muted/40 p-4 text-xs">
            {generated.content}
          </pre>

          <Form method="post">
            <input type="hidden" name="intent" value="save" />
            <input type="hidden" name="path" value={generated.path} />
            <input type="hidden" name="content" value={generated.content} />
            <Button type="submit" disabled={busy}>
              {busy ? "Opening PR…" : "Save as pull request"}
            </Button>
          </Form>
        </section>
      )}
    </AppShell>
  );
}
