/**
 * Playground — a direct line to a deployed agent (Observe/operate: PRD channels treat web chat
 * as an entry point; this is the platform-testing version of it).
 *
 * Pick a live deployment (explicit version — useful when several run behind the splitter),
 * type a message, and the server proxies one turn over eve's session API (agent/talk.server.ts)
 * and renders the reply plus the agent's steps. Prose renders as text; structured (JSON)
 * replies render as code. The transcript lives in component state — this is a testing surface,
 * not a durable channel; real conversations belong to the agent's own channels.
 */
import { authkitLoader, withAuth } from "@workos-inc/authkit-react-router";
import { useEffect, useRef, useState } from "react";
import { redirect, useFetcher, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";

import { sendTurn, type TurnResult } from "~/agent/talk.server";
import { AgentNav, AppShell, PageHeader } from "~/components/shell";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { listDeployments } from "~/deploy/controller.server";
import { newId } from "~/lib/id";
import { listEnvironments } from "~/db/queries.server";
import { requireProject, requireRepo } from "~/project/guard.server";
import type { Route } from "./+types/projects.$projectId.playground";

interface Target {
  deploymentId: string;
  url: string;
  version: string;
  environmentName: string;
}

async function liveTargets(projectId: string): Promise<Target[]> {
  const envs = await listEnvironments(projectId);
  const perEnv = await Promise.all(
    envs.map(async (env) => {
      const deployments = await listDeployments(env.id);
      return deployments.flatMap((d) =>
        d.status === "live" && d.url
          ? [
              {
                deploymentId: d.id,
                url: d.url,
                version: d.version,
                environmentName: env.name,
              },
            ]
          : [],
      );
    }),
  );
  return perEnv.flat();
}

export const loader = (args: LoaderFunctionArgs) =>
  authkitLoader(
    args,
    async ({ auth }) => {
      const project = requireRepo(
        await requireProject(
          { user: auth.user, organizationId: auth.organizationId, role: auth.role },
          args.params.projectId,
        ),
      );
      return { project, targets: await liveTargets(project.id) };
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
  const deploymentId = String(form.get("deploymentId") ?? "");
  const message = String(form.get("message") ?? "").trim();
  const sessionId = String(form.get("sessionId") ?? "") || null;
  const continuationToken = String(form.get("continuationToken") ?? "") || null;
  if (!message) return { error: "Type a message first." } as const;

  // Only talk to live deployments that belong to THIS project (tenancy guard).
  const targets = await liveTargets(project.id);
  const target = targets.find((t) => t.deploymentId === deploymentId);
  if (!target) {
    return {
      error: "That deployment isn't live (or isn't part of this agent). Deploy first.",
    } as const;
  }

  const result = await sendTurn({ baseUrl: target.url, message, sessionId, continuationToken });
  return { result, version: target.version } as const;
}

export function meta() {
  return [{ title: "Playground · Eden" }];
}

interface ChatEntry {
  /** Stable render key — transcript entries are append-only client state. */
  id: string;
  role: "user" | "assistant";
  text: string;
  structured?: boolean;
  version?: string;
  modelId?: string | null;
  steps?: TurnResult["steps"];
  error?: string | null;
}

export default function Playground({ loaderData }: Route.ComponentProps) {
  const { project, targets } = loaderData;
  const base = `/projects/${project.id}`;
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";

  const [entries, setEntries] = useState<ChatEntry[]>([]);
  // Session continuity: follow-up turns POST to the same eve session with its token.
  const [session, setSession] = useState<{ id: string; token: string } | null>(null);
  const lastHandled = useRef<unknown>(null);

  // Append the assistant reply when a turn returns (once per response object).
  useEffect(() => {
    const data = fetcher.data;
    if (!data || fetcher.state !== "idle" || lastHandled.current === data) return;
    lastHandled.current = data;
    if ("error" in data && data.error) {
      setEntries((prev) => [
        ...prev,
        { id: newId(), role: "assistant", text: "", error: data.error },
      ]);
      return;
    }
    if ("result" in data && data.result) {
      const r = data.result;
      setEntries((prev) => [
        ...prev,
        {
          id: newId(),
          role: "assistant",
          text: r.reply ?? "",
          structured: r.replyIsStructured,
          version: data.version,
          modelId: r.modelId,
          steps: r.steps,
          error: r.error,
        },
      ]);
      if (r.sessionId && r.continuationToken) {
        setSession({ id: r.sessionId, token: r.continuationToken });
      }
    }
  }, [fetcher.data, fetcher.state]);

  return (
    <AppShell>
      <PageHeader
        title="Playground"
        description="Talk to a live deployment of this agent. Each reply is tagged with the version that produced it."
        actions={
          entries.length > 0 ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setEntries([]);
                setSession(null);
              }}
            >
              New conversation
            </Button>
          ) : undefined
        }
      />
      <AgentNav base={base} />

      {targets.length === 0 ? (
        <Alert>
          <AlertTitle>No live deployment to talk to</AlertTitle>
          <AlertDescription>
            Deploy a release first (Deployments tab), then come back here to try it.
          </AlertDescription>
        </Alert>
      ) : (
        <div className="space-y-4">
          {/* Transcript */}
          {entries.length > 0 && (
            <div className="space-y-3">
              {entries.map((e) => (
                <ChatBubble key={e.id} entry={e} />
              ))}
            </div>
          )}

          {/* Composer */}
          <Card>
            <CardContent className="pt-6">
              <fetcher.Form
                method="post"
                onSubmit={(event) => {
                  const message = String(
                    new FormData(event.currentTarget).get("message") ?? "",
                  ).trim();
                  if (message) {
                    setEntries((prev) => [
                      ...prev,
                      { id: newId(), role: "user", text: message },
                    ]);
                  }
                }}
              >
                <input type="hidden" name="sessionId" value={session?.id ?? ""} />
                <input type="hidden" name="continuationToken" value={session?.token ?? ""} />
                <div className="flex flex-wrap items-end gap-3">
                  <div className="min-w-0 flex-1">
                    <Textarea
                      name="message"
                      key={entries.length /* clear after each send */}
                      placeholder="Say something to the agent…"
                      aria-label="Message to the agent"
                      className="min-h-20"
                      disabled={busy}
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Select name="deploymentId" defaultValue={targets[0].deploymentId}>
                      <SelectTrigger className="min-w-44" aria-label="Deployment to talk to">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {targets.map((t) => (
                          <SelectItem key={t.deploymentId} value={t.deploymentId}>
                            {t.version} · {t.environmentName}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button type="submit" disabled={busy}>
                      {busy ? "Thinking…" : "Send"}
                    </Button>
                  </div>
                </div>
              </fetcher.Form>
            </CardContent>
          </Card>
        </div>
      )}
    </AppShell>
  );
}

function ChatBubble({ entry }: { entry: ChatEntry }) {
  if (entry.role === "user") {
    return (
      <div className="ml-auto max-w-[85%] rounded-xl bg-primary px-4 py-2.5 text-sm text-primary-foreground">
        <p className="whitespace-pre-wrap">{entry.text}</p>
      </div>
    );
  }
  return (
    <div className="max-w-[85%] rounded-xl border bg-card px-4 py-2.5 text-sm">
      {entry.version && (
        <span className="mb-1.5 flex items-center gap-1.5">
          <Badge variant="secondary" className="text-xs">
            {entry.version}
          </Badge>
          {entry.modelId && (
            <span className="font-mono text-xs text-muted-foreground">
              {entry.modelId}
            </span>
          )}
        </span>
      )}
      {entry.error ? (
        <p className="text-destructive">{entry.error}</p>
      ) : entry.structured ? (
        <pre className="overflow-x-auto rounded-lg bg-muted/50 p-3 font-mono text-xs">
          {entry.text}
        </pre>
      ) : (
        <p className="whitespace-pre-wrap">{entry.text || "(empty reply)"}</p>
      )}
      {entry.steps && entry.steps.length > 0 && (
        <details className="mt-2 text-xs text-muted-foreground">
          <summary className="cursor-pointer">
            {entry.steps.length} step{entry.steps.length === 1 ? "" : "s"}
          </summary>
          <ul className="mt-1 space-y-0.5">
            {entry.steps.map((s, i) => (
              <li key={`${entry.id}-step-${s.type}-${i}`} className="font-mono">
                {s.type}
                {s.name ? ` · ${s.name}` : ""}
                {s.durationMs != null ? ` · ${(s.durationMs / 1000).toFixed(1)}s` : ""}
                {s.tokensIn != null || s.tokensOut != null
                  ? ` · ${s.tokensIn ?? 0} in / ${s.tokensOut ?? 0} out tok`
                  : ""}
                {s.isError ? " · failed" : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
