/**
 * Playground — a persistent per-agent conversation with a live deployment of this agent.
 *
 * The transcript and the eve session (id + continuation token) persist server-side
 * (chat/conversation.server.ts): navigate away and back, the conversation is still here and
 * follow-up turns keep the agent's context. Idle 24h → fresh start. Switching to a different
 * deployment keeps the visible transcript but starts a new eve session (versions don't share
 * memory).
 *
 * Turns STREAM: the composer POSTs to the streaming resource route
 * (api.projects.$projectId.playground.stream) and this component reads back an NDJSON feed of
 * the turn — live reply text, current activity, and completed steps — so long agent turns show
 * progress instead of one spinner. On completion it revalidates; the persisted transcript
 * (saved server-side, disconnect-safe) takes over seamlessly.
 */
import { authkitLoader, withAuth } from "@workos-inc/authkit-react-router";
import { Loader2 } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  redirect,
  useFetcher,
  useRevalidator,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import {
  loadConversation,
  resetConversation,
} from "~/chat/conversation.server";
import {
  EMPTY_STATE,
  liveTargets,
  playgroundKind,
  type PlaygroundState,
  type Target,
} from "~/chat/playground.server";
import type { ChatEntry, ChatStep } from "~/chat/types";
import {
  AssistantBubble,
  ChatComposer,
  ChatTranscript,
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
import { contextPath } from "~/lib/paths";
import {
  agentFromParams,
  agentParamRedirect,
  resolveAgentContext,
} from "~/project/agent-context.server";
import { requireProject, requireRepo } from "~/project/guard.server";
import type { Route } from "./+types/projects.$projectId.playground";

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
      const agentName = agentFromParams(args.params);
      if (!agentName) {
        const legacy = agentParamRedirect(args.request, project.id);
        if (legacy) throw legacy;
      }
      const { roster, active, isTeam } = await resolveAgentContext(
        project.id,
        agentName,
      );
      // Teams have no repo-level Playground — the tab exists only at the member level.
      if (isTeam && !agentName) throw redirect(`/repos/${project.id}`);

      const [targets, conversation] = await Promise.all([
        liveTargets(active.id),
        loadConversation<PlaygroundState>(
          project.id,
          playgroundKind(active.id),
          auth.user!.id,
          EMPTY_STATE,
        ),
      ]);
      return {
        project,
        targets,
        entries: conversation.entries,
        expired: conversation.expired,
        lastDeploymentId: conversation.state.deploymentId,
        roster: roster.map((a) => ({ name: a.name })),
        activeAgent: active.name,
        isTeam,
      };
    },
    { ensureSignedIn: true },
  );

/** The action now only handles "New conversation" — turns go through the stream route. */
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
  const agentName = agentFromParams(args.params);
  const { active, isTeam } = await resolveAgentContext(project.id, agentName);
  if (isTeam && !agentName) throw redirect(`/repos/${project.id}`);
  const kind = playgroundKind(active.id);

  const form = await args.request.formData();
  if (String(form.get("intent")) === "reset") {
    await resetConversation(project.id, kind, auth.user.id);
    return { ok: true as const };
  }
  return { ok: true as const };
}

export function meta() {
  return [{ title: "Playground · Eden" }];
}

/** Local mirror of an in-flight turn, driven by the NDJSON stream. */
interface LiveTurn {
  userText: string;
  text: string;
  steps: ChatStep[];
  activity: string | null;
  modelId: string | null;
  error: string | null;
  done: boolean;
}

export default function Playground({ loaderData }: Route.ComponentProps) {
  const {
    project,
    targets,
    entries,
    expired,
    lastDeploymentId,
    roster,
    activeAgent,
    isTeam,
  } = loaderData;
  const base = contextPath(project.id, isTeam ? activeAgent : null);
  const resetFetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();

  const [live, setLive] = useState<LiveTurn | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const busy = live !== null && !live.done;

  const defaultTarget =
    targets.find((t) => t.deploymentId === lastDeploymentId) ?? targets[0];
  const [deploymentId, setDeploymentId] = useState(
    defaultTarget?.deploymentId ?? "",
  );
  const deploymentRef = useRef(deploymentId);
  deploymentRef.current = deploymentId;

  const send = useCallback(
    async (message: string) => {
      setSendError(null);
      setLive({
        userText: message,
        text: "",
        steps: [],
        activity: "Thinking…",
        modelId: null,
        error: null,
        done: false,
      });
      const apply = (evt: StreamEvent) =>
        setLive((prev) => (prev ? reduceLive(prev, evt) : prev));

      const form = new FormData();
      form.set("message", message);
      form.set("deploymentId", deploymentRef.current);
      form.set("agentName", activeAgent);

      try {
        const res = await fetch(
          `/api/repos/${project.id}/playground/stream`,
          { method: "POST", body: form },
        );
        if (!res.ok || !res.body) {
          const detail = await res.json().catch(() => null);
          throw new Error(
            (detail && typeof detail === "object" && "error" in detail
              ? String((detail as { error: unknown }).error)
              : null) ?? `Stream failed (${res.status}).`,
          );
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            let evt: StreamEvent;
            try {
              evt = JSON.parse(line) as StreamEvent;
            } catch {
              continue;
            }
            apply(evt);
          }
        }
        // Stream ended — the server has persisted the turn. Revalidate, then hand the
        // transcript back to the loader's persisted entries.
        await revalidator.revalidate();
        setLive(null);
      } catch (error) {
        // The server still persists in the background — revalidate so the reply isn't lost.
        setLive((prev) =>
          prev
            ? {
                ...prev,
                error: `Lost the live stream: ${(error as Error).message}`,
                activity: null,
                done: true,
              }
            : prev,
        );
        setSendError(
          "The live view dropped — the reply may still have been recorded.",
        );
        await revalidator.revalidate();
        setLive(null);
      }
    },
    [activeAgent, project.id, revalidator],
  );

  // Stable element between renders so the composer (and any memoized child) doesn't redraw.
  const targetPicker = useMemo(
    () => (
      <Select value={deploymentId} onValueChange={setDeploymentId}>
        <SelectTrigger
          className="h-9 min-w-44 border-0 bg-muted/60 text-xs shadow-none hover:bg-muted"
          aria-label="Deployment to talk to"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {targets.map((t: Target) => (
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
    <AppShell
      breadcrumbs={repoCrumbs({
        projectId: project.id,
        repoName: project.name,
        isTeam,
        agentName: activeAgent,
        tail: [{ label: "Playground" }],
      })}
    >
      <AgentNav
        base={base}
        level={isTeam ? "member" : "single"}
        roster={roster}
        activeAgent={isTeam ? activeAgent : undefined}
      />
      <PageHeader
        title={isTeam ? `Playground — ${activeAgent}` : "Playground"}
        description="Talk to a live deployment of this agent. Each reply is tagged with the version that produced it."
        actions={
          entries.length > 0 ? (
            <resetFetcher.Form method="post">
              <input type="hidden" name="intent" value="reset" />
              <Button type="submit" variant="outline" size="sm" disabled={busy}>
                New conversation
              </Button>
            </resetFetcher.Form>
          ) : undefined
        }
      />

      {targets.length === 0 ? (
        <Alert>
          <AlertTitle>No live deployment to talk to</AlertTitle>
          <AlertDescription>
            Deploy this agent first (Deployment tab), then come back here to try
            it.
          </AlertDescription>
        </Alert>
      ) : (
        <div className="space-y-4 pb-4">
          {expired && entries.length === 0 && (
            <Alert>
              <AlertDescription>
                Your previous conversation expired after a day of inactivity —
                starting fresh.
              </AlertDescription>
            </Alert>
          )}
          {sendError && (
            <Alert variant="destructive">
              <AlertDescription>{sendError}</AlertDescription>
            </Alert>
          )}

          <ChatTranscript
            dep={`${entries.length}:${live ? live.text.length + live.steps.length : 0}`}
          >
            {entries.length === 0 && !live && (
              <p className="py-8 text-center text-sm text-muted-foreground">
                Say something to the agent — the conversation keeps its context
                across turns.
              </p>
            )}
            {(entries as ChatEntry[]).map((e) =>
              e.role === "user" ? (
                <UserBubble key={e.id} text={e.text} />
              ) : (
                <AgentEntry key={e.id} entry={e} />
              ),
            )}
            {live && (
              <>
                <UserBubble text={live.userText} />
                <LiveBubble live={live} />
              </>
            )}
          </ChatTranscript>

          <ChatComposer
            placeholder={
              isTeam
                ? `Say something to ${activeAgent}...`
                : "Say something to the agent..."
            }
            busy={busy}
            onSend={send}
            controls={targetPicker}
          />
        </div>
      )}
    </AppShell>
  );
}

type StreamEvent =
  | { type: "model"; modelId: string }
  | { type: "thinking" }
  | { type: "action"; toolName: string; summary: string | null }
  | { type: "text"; text: string }
  | { type: "step"; step: ChatStep }
  | {
      type: "done";
      ok: boolean;
      reply: string | null;
      structured: boolean;
      error: string | null;
      modelId: string | null;
      version: string;
    };

/** Fold one stream event into the live turn state (pure — safe inside a functional setState). */
function reduceLive(prev: LiveTurn, evt: StreamEvent): LiveTurn {
  switch (evt.type) {
    case "model":
      return { ...prev, modelId: evt.modelId };
    case "thinking":
      return { ...prev, activity: "Thinking…" };
    case "action":
      return {
        ...prev,
        activity: evt.summary
          ? `${evt.toolName}: ${evt.summary}`
          : evt.toolName,
      };
    case "text":
      return { ...prev, text: evt.text };
    case "step":
      return {
        ...prev,
        steps: [...prev.steps, evt.step],
        activity: "Thinking…",
      };
    case "done":
      return {
        ...prev,
        text: evt.reply ?? prev.text,
        error: evt.error,
        modelId: evt.modelId ?? prev.modelId,
        activity: null,
        done: true,
      };
    default:
      return prev;
  }
}

/** The live, in-flight assistant bubble: streaming reply, an activity line, and a step list. */
function LiveBubble({ live }: { live: LiveTurn }) {
  return (
    <AssistantBubble>
      {live.modelId && (
        <span className="mb-1.5 flex items-center gap-1.5">
          <span className="font-mono text-xs text-muted-foreground">
            {live.modelId}
          </span>
        </span>
      )}
      {live.error ? (
        <p className="whitespace-pre-wrap text-destructive">{live.error}</p>
      ) : live.text ? (
        <p className="whitespace-pre-wrap">{live.text}</p>
      ) : null}
      {!live.done && live.activity && (
        <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="size-3 shrink-0 animate-spin" />
          <span className="truncate font-mono">{live.activity}</span>
        </div>
      )}
      <StepList steps={live.steps} idPrefix="live" open />
    </AssistantBubble>
  );
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
            <span className="font-mono text-xs text-muted-foreground">
              {entry.modelId}
            </span>
          )}
        </span>
      )}
      {entry.error ? (
        <p className="whitespace-pre-wrap text-destructive">{entry.error}</p>
      ) : entry.structured ? (
        <pre className="overflow-x-auto rounded-lg bg-muted/50 p-3 font-mono text-xs">
          {entry.text}
        </pre>
      ) : (
        <p className="whitespace-pre-wrap">{entry.text || "(empty reply)"}</p>
      )}
      <StepList steps={entry.steps ?? []} idPrefix={entry.id} />
    </AssistantBubble>
  );
}

/**
 * The per-turn step list, shared by persisted entries and the live bubble. Each step shows its
 * tool + summary (the useful part) with duration/tokens, and failed steps surface their detail.
 */
function StepList({
  steps,
  idPrefix,
  open,
}: {
  steps: ChatStep[];
  idPrefix: string;
  open?: boolean;
}) {
  if (steps.length === 0) return null;
  return (
    <details className="mt-2 text-xs text-muted-foreground" open={open}>
      <summary className="cursor-pointer">
        {steps.length} step{steps.length === 1 ? "" : "s"}
      </summary>
      <ul className="mt-1 space-y-0.5">
        {steps.map((s, i) => (
          <li key={`${idPrefix}-step-${s.type}-${i}`} className="font-mono">
            <div>
              {s.toolName ?? s.type}
              {s.summary ? ` · ${s.summary}` : s.name ? ` · ${s.name}` : ""}
              {s.durationMs != null
                ? ` · ${(s.durationMs / 1000).toFixed(1)}s`
                : ""}
              {s.tokensIn != null || s.tokensOut != null
                ? ` · ${s.tokensIn ?? 0} in / ${s.tokensOut ?? 0} out tok`
                : ""}
              {s.isError ? " · failed" : ""}
            </div>
            {(s.message || s.code || s.details) && (
              <div className="mt-0.5 whitespace-pre-wrap pl-3 text-destructive">
                {s.message}
                {s.code ? `${s.message ? "\n" : ""}Code: ${s.code}` : ""}
                {s.details
                  ? `${s.message || s.code ? "\n" : ""}Details: ${s.details}`
                  : ""}
              </div>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
