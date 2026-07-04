/**
 * Playground — a persistent conversation with a live deployment of this agent.
 *
 * The transcript and the eve session (id + continuation token) persist server-side
 * (chat/conversation.server.ts): navigate away and back, the conversation is still here and
 * follow-up turns keep the agent's context. Idle 24h → fresh start. Switching to a different
 * deployment keeps the visible transcript but starts a new eve session (versions don't share
 * memory).
 */
import { authkitLoader, withAuth } from "@workos-inc/authkit-react-router";
import { useMemo, useState } from "react";
import { redirect, useFetcher, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";

import { sendTurn } from "~/agent/talk.server";
import {
  loadConversation,
  resetConversation,
  saveConversation,
} from "~/chat/conversation.server";
import type { ChatEntry } from "~/chat/types";
import {
  AssistantBubble,
  ChatComposer,
  ChatTranscript,
  PendingBubble,
  UserBubble,
} from "~/components/chat";
import { AgentNav, AppShell, PageHeader, repoCrumbs } from "~/components/shell";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { listDeployments } from "~/deploy/controller.server";
import { listEnvironments } from "~/db/queries.server";
import { newId } from "~/lib/id";
import { agentParam, resolveAgentContext } from "~/project/agent-context.server";
import { requireProject, requireRepo } from "~/project/guard.server";
import type { Route } from "./+types/projects.$projectId.playground";

interface Target {
  deploymentId: string;
  url: string;
  version: string;
  environmentName: string;
}

interface PlaygroundState extends Record<string, unknown> {
  deploymentId: string | null;
  sessionId: string | null;
  continuationToken: string | null;
}

const EMPTY_STATE: PlaygroundState = {
  deploymentId: null,
  sessionId: null,
  continuationToken: null,
};

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
      const [targets, conversation, { roster, active }] = await Promise.all([
        liveTargets(project.id),
        loadConversation<PlaygroundState>(
          project.id,
          "playground",
          auth.user!.id,
          EMPTY_STATE,
        ),
        resolveAgentContext(project.id, agentParam(args.request)),
      ]);
      return {
        project,
        targets,
        entries: conversation.entries,
        expired: conversation.expired,
        lastDeploymentId: conversation.state.deploymentId,
        roster: roster.map((a) => ({ name: a.name })),
        activeAgent: active.name,
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
  if (String(form.get("intent")) === "reset") {
    await resetConversation(project.id, "playground", auth.user.id);
    return { ok: true as const };
  }

  const deploymentId = String(form.get("deploymentId") ?? "");
  const message = String(form.get("message") ?? "").trim();
  if (!message) return { error: "Type a message first." };

  // Only talk to live deployments that belong to THIS project (tenancy guard).
  const targets = await liveTargets(project.id);
  const target = targets.find((t) => t.deploymentId === deploymentId);
  if (!target) {
    return { error: "That deployment isn't live (or isn't part of this agent). Deploy first." };
  }

  const conversation = await loadConversation<PlaygroundState>(
    project.id,
    "playground",
    auth.user.id,
    EMPTY_STATE,
  );
  // A different deployment doesn't share the eve session — keep the transcript, drop tokens.
  const sameTarget = conversation.state.deploymentId === deploymentId;
  const entries = [...conversation.entries];
  entries.push({ id: newId(), role: "user", text: message });

  const result = await sendTurn({
    baseUrl: target.url,
    message,
    sessionId: sameTarget ? conversation.state.sessionId : null,
    continuationToken: sameTarget ? conversation.state.continuationToken : null,
  });
  entries.push({
    id: newId(),
    role: "assistant",
    text: result.reply ?? "",
    structured: result.replyIsStructured,
    version: target.version,
    modelId: result.modelId,
    steps: result.steps,
    error: result.error,
  });

  await saveConversation(project.id, "playground", auth.user.id, entries, {
    deploymentId,
    sessionId: result.sessionId ?? null,
    continuationToken: result.continuationToken ?? null,
  } satisfies PlaygroundState);
  return { ok: true as const };
}

export function meta() {
  return [{ title: "Playground · Eden" }];
}

export default function Playground({ loaderData }: Route.ComponentProps) {
  const { project, targets, entries, expired, lastDeploymentId, roster, activeAgent } =
    loaderData;
  const base = `/repos/${project.id}`;
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const pendingMessage =
    busy && fetcher.formData?.get("intent") !== "reset"
      ? String(fetcher.formData?.get("message") ?? "")
      : null;

  const defaultTarget =
    targets.find((t) => t.deploymentId === lastDeploymentId) ?? targets[0];
  const [deploymentId, setDeploymentId] = useState(defaultTarget?.deploymentId ?? "");

  // Stable element between renders so the composer (and any memoized child) doesn't redraw.
  const targetPicker = useMemo(
    () => (
      <Select value={deploymentId} onValueChange={setDeploymentId}>
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
    ),
    [deploymentId, targets],
  );

  return (
    <AppShell breadcrumbs={repoCrumbs({ projectId: project.id, repoName: project.name, isTeam: roster.length > 1, agentName: activeAgent, tail: [{ label: "Playground" }] })}>
      <PageHeader
        title="Playground"
        description="Talk to a live deployment of this agent. Each reply is tagged with the version that produced it."
        actions={
          entries.length > 0 ? (
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="reset" />
              <Button type="submit" variant="outline" size="sm" disabled={busy}>
                New conversation
              </Button>
            </fetcher.Form>
          ) : undefined
        }
      />
      <AgentNav base={base} roster={roster} activeAgent={activeAgent} />

      {targets.length === 0 ? (
        <Alert>
          <AlertTitle>No live deployment to talk to</AlertTitle>
          <AlertDescription>
            Deploy a release first (Deployments tab), then come back here to try it.
          </AlertDescription>
        </Alert>
      ) : (
        <div className="space-y-4 pb-4">
          {expired && entries.length === 0 && (
            <Alert>
              <AlertDescription>
                Your previous conversation expired after a day of inactivity — starting fresh.
              </AlertDescription>
            </Alert>
          )}
          {actionError(fetcher.data) && (
            <Alert variant="destructive">
              <AlertDescription>{actionError(fetcher.data)}</AlertDescription>
            </Alert>
          )}

          <ChatTranscript dep={`${entries.length}:${pendingMessage ?? ""}`}>
            {entries.length === 0 && !pendingMessage && (
              <p className="py-8 text-center text-sm text-muted-foreground">
                Say something to the agent — the conversation keeps its context across turns.
              </p>
            )}
            {(entries as ChatEntry[]).map((e) =>
              e.role === "user" ? (
                <UserBubble key={e.id} text={e.text} />
              ) : (
                <AgentEntry key={e.id} entry={e} />
              ),
            )}
            {pendingMessage && (
              <>
                <UserBubble text={pendingMessage} />
                <PendingBubble label="Thinking…" />
              </>
            )}
          </ChatTranscript>

          <ChatComposer
            placeholder="Say something to the agent…"
            busy={busy}
            busyLabel="Thinking…"
            onSend={(message) =>
              fetcher.submit({ message, deploymentId }, { method: "post" })
            }
            extras={targetPicker}
          />
        </div>
      )}
    </AppShell>
  );
}

function actionError(data: unknown): string | null {
  return data && typeof data === "object" && "error" in data
    ? String((data as { error: unknown }).error)
    : null;
}

function AgentEntry({ entry }: { entry: ChatEntry }) {
  return (
    <AssistantBubble>
      {entry.version && (
        <span className="mb-1.5 flex items-center gap-1.5">
          <Badge variant="secondary" className="text-xs">
            {entry.version}
          </Badge>
          {entry.modelId && (
            <span className="font-mono text-xs text-muted-foreground">{entry.modelId}</span>
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
    </AssistantBubble>
  );
}
