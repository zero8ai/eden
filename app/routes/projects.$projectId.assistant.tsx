/**
 * Embedded authoring assistant (Author pillar, PRD §7.2 / D4).
 *
 * The PM describes what they want; the assistant AGENT (assistant/agent.server.ts) explores
 * the repo, writes files to the conventional locations, adds npm dependencies when justified
 * (lockfile regenerated properly), and runs the build/typecheck gate until green — all per
 * the METHOD system prompt. Everything it writes lands as staged drafts, reviewed and
 * published from the Changes tab like any human edit. Model access is OpenRouter via the
 * workspace key (Org settings), per PRD §12.
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
import { runAuthoringAgent, type AuthoringRunResult } from "~/assistant/agent.server";
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
  | { kind: "done"; result: AuthoringRunResult }
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
  const instruction = String(form.get("instruction") ?? "").trim();
  if (!instruction) return { kind: "error", message: "Describe what you want built." };

  try {
    const result = await runAuthoringAgent({
      project,
      instruction,
      createdBy: auth.user.id,
    });
    return { kind: "done", result };
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
  const busy = navigation.state !== "idle";
  const done = actionData?.kind === "done" ? actionData.result : null;

  const base = `/projects/${project.id}`;

  return (
    <AppShell workspaceName={project.name}>
      <PageHeader
        title="Authoring assistant"
        description="Describe what you want in plain language. The assistant writes the code, adds any dependencies, and verifies the build — then you review and publish from Changes."
        actions={
          <Button variant="outline" asChild>
            <Link to={base}>← {project.name}</Link>
          </Button>
        }
      />
      <AgentNav base={base} />

      {actionData?.kind === "error" && (
        <Alert variant="destructive" className="mb-6">
          <AlertDescription className="whitespace-pre-wrap">
            {actionData.message}
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>What should the agent be able to do?</CardTitle>
        </CardHeader>
        <CardContent>
          <Form method="post">
            <Textarea
              name="instruction"
              rows={3}
              placeholder="e.g. Add a tool that sends a message to our Discord channel."
            />
            <div className="mt-3 flex items-center gap-3">
              <Button type="submit" disabled={busy}>
                {busy ? "Working… (writes, builds & verifies — can take a minute)" : "Build it"}
              </Button>
            </div>
          </Form>
        </CardContent>
      </Card>

      {done && (
        <section className="mt-8 space-y-4">
          <Alert>
            <AlertTitle>
              {done.checks.ran
                ? done.checks.ok
                  ? "Done — checks passed"
                  : "Finished with failing checks"
                : "Done"}
            </AlertTitle>
            <AlertDescription className="space-y-2">
              <p className="whitespace-pre-wrap">{done.summary}</p>
              {done.secretsNeeded.length > 0 && (
                <p>
                  Secrets to set before deploying:{" "}
                  {done.secretsNeeded.map((s) => (
                    <Badge key={s} variant="secondary" className="mr-1 font-mono">
                      {s}
                    </Badge>
                  ))}
                  —{" "}
                  <Link className="underline" to={`${base}/secrets`}>
                    set them in Secrets
                  </Link>
                  .
                </p>
              )}
            </AlertDescription>
          </Alert>

          {done.files.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Staged files</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="divide-y rounded-lg border text-sm">
                  {done.files.map((f) => (
                    <li key={f} className="px-3 py-2">
                      <Link
                        to={`${base}/edit?path=${encodeURIComponent(f)}`}
                        className="font-mono text-xs underline-offset-4 hover:underline"
                      >
                        {f}
                      </Link>
                    </li>
                  ))}
                </ul>
                <p className="mt-3 text-sm">
                  <Link
                    to={`${base}/changes`}
                    className="font-medium underline underline-offset-4"
                  >
                    Review &amp; publish in Changes →
                  </Link>
                </p>
              </CardContent>
            </Card>
          )}

          {done.checks.ran && !done.checks.ok && done.checks.output && (
            <Alert variant="destructive">
              <AlertTitle>Last check output</AlertTitle>
              <AlertDescription className="whitespace-pre-wrap font-mono text-xs">
                {done.checks.output}
              </AlertDescription>
            </Alert>
          )}
        </section>
      )}
    </AppShell>
  );
}
