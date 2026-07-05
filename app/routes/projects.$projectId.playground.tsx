/**
 * Playground — persistent Eve sessions with a live deployment of this agent.
 *
 * Eden stores only the app-owned Eve session cursor/listing. The transcript is rebuilt from
 * Eve's durable event stream on load, so Eve/Workflow World remains the source of truth for
 * conversation history.
 *
 * Turns STREAM: the composer POSTs to the streaming resource route
 * (api.projects.$projectId.playground.stream) and this component reads back an NDJSON feed of
 * the turn — live reply text, current activity, and completed steps — so long agent turns show
 * progress instead of one spinner. On completion it revalidates and replays Eve history.
 */
import { authkitLoader, withAuth } from "@workos-inc/authkit-react-router";
import { Loader2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import {
  Form,
  redirect,
  useNavigate,
  useRevalidator,
  useSearchParams,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { liveTargets, type Target } from "~/chat/playground.server";
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
  createPlaygroundSession,
  loadPlaygroundEntriesFromEve,
  listPlaygroundSessions,
  summarizePlaygroundSession,
} from "~/playground/sessions.server";
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

      const [targets, sessions] = await Promise.all([
        liveTargets(active.id),
        listPlaygroundSessions({
          projectId: project.id,
          agentId: active.id,
          userId: auth.user!.id,
        }),
      ]);
      const selectedSessionId = new URL(args.request.url).searchParams.get("session");
      const currentSession =
        (selectedSessionId
          ? sessions.find((session) => session.id === selectedSessionId)
          : null) ??
        sessions[0] ??
        null;
      const historyTarget = currentSession
        ? (targets.find((target) => target.environmentId === currentSession.environmentId) ??
          targets.find((target) => target.deploymentId === currentSession.lastDeploymentId) ??
          null)
        : null;
      let entries: ChatEntry[] = [];
      let historyError: string | null = null;
      if (currentSession?.externalSessionId) {
        if (historyTarget) {
          try {
            entries = await loadPlaygroundEntriesFromEve({
              session: currentSession,
              target: historyTarget,
            });
          } catch (error) {
            historyError = `Couldn't reload Eve session history: ${(error as Error).message}`;
          }
        } else {
          historyError =
            "This session's environment does not have a live deployment to replay Eve history from.";
        }
      }
      return {
        project,
        targets,
        sessions: sessions.map(summarizePlaygroundSession),
        currentSessionId: currentSession?.id ?? null,
        currentSessionEnvironmentId: currentSession?.environmentId ?? null,
        entries,
        historyError,
        lastDeploymentId: currentSession?.lastDeploymentId ?? null,
        roster: roster.map((a) => ({ name: a.name })),
        activeAgent: active.name,
        isTeam,
      };
    },
    { ensureSignedIn: true },
  );

/** The action creates a new Eden session row; turns go through the stream route. */
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

  const form = await args.request.formData();
  if (String(form.get("intent")) === "new-session") {
    const session = await createPlaygroundSession({
      projectId: project.id,
      agentId: active.id,
      userId: auth.user.id,
    });
    const url = new URL(args.request.url);
    url.searchParams.set("session", session.id);
    throw redirect(`${url.pathname}?${url.searchParams.toString()}`);
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
    sessions,
    currentSessionId,
    currentSessionEnvironmentId,
    entries,
    historyError,
    lastDeploymentId,
    roster,
    activeAgent,
    isTeam,
  } = loaderData;
  const base = contextPath(project.id, isTeam ? activeAgent : null);
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const [searchParams, setSearchParams] = useSearchParams();

  const [live, setLive] = useState<LiveTurn | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const busy = live !== null && !live.done;

  const defaultTarget =
    targets.find((t) => t.environmentId === currentSessionEnvironmentId) ??
    targets.find((t) => t.deploymentId === lastDeploymentId) ??
    targets[0];
  const requestedDeploymentId = searchParams.get("deployment");
  const selectedTarget =
    targets.find(
      (target) =>
        target.deploymentId === requestedDeploymentId &&
        (!currentSessionEnvironmentId ||
          target.environmentId === currentSessionEnvironmentId),
    ) ?? defaultTarget;
  const deploymentId = selectedTarget?.deploymentId ?? "";

  const sessionPicker = useMemo(() => {
    if (!currentSessionId || sessions.length === 0) return null;
    return (
      <Select
        value={currentSessionId}
        onValueChange={(id) =>
          navigate(`${base}/playground?session=${encodeURIComponent(id)}`)
        }
      >
        <SelectTrigger
          className="h-9 w-52 border-0 bg-muted/60 text-xs shadow-none hover:bg-muted"
          aria-label="Playground session"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {sessions.map((session) => (
            <SelectItem key={session.id} value={session.id}>
              {formatSessionLabel(session.title, session.updatedAt)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }, [base, currentSessionId, navigate, sessions]);

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
      form.set("deploymentId", deploymentId);
      form.set("agentName", activeAgent);
      if (currentSessionId) form.set("playgroundSessionId", currentSessionId);

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
        let nextSessionId = currentSessionId;
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
            if (evt.type === "done" && evt.playgroundSessionId) {
              nextSessionId = evt.playgroundSessionId;
            }
            apply(evt);
          }
        }
        // Stream ended — the server has persisted the cursor. Revalidate, then replay Eve
        // history through the loader.
        await revalidator.revalidate();
        if (!currentSessionId && nextSessionId) {
          navigate(`${base}/playground?session=${encodeURIComponent(nextSessionId)}`, {
            replace: true,
          });
        }
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
    [activeAgent, base, currentSessionId, deploymentId, navigate, project.id, revalidator],
  );

  // Stable element between renders so the composer (and any memoized child) doesn't redraw.
  const targetPicker = useMemo(
    () => (
      <Select
        value={deploymentId}
        onValueChange={(nextDeploymentId) => {
          const next = new URLSearchParams(searchParams);
          next.set("deployment", nextDeploymentId);
          setSearchParams(next, { replace: true });
        }}
      >
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
    [deploymentId, searchParams, setSearchParams, targets],
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
        description="Talk to a live deployment of this agent. Conversation history reloads from Eve's durable session stream."
        actions={
          <div className="flex items-center gap-2">
            {sessionPicker}
            <Form method="post">
              <input type="hidden" name="intent" value="new-session" />
              <Button type="submit" variant="outline" size="sm" disabled={busy}>
                New conversation
              </Button>
            </Form>
          </div>
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
          {historyError && (
            <Alert variant="destructive">
              <AlertDescription>{historyError}</AlertDescription>
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
      playgroundSessionId?: string;
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

function formatSessionLabel(title: string, updatedAt: string): string {
  const date = new Date(updatedAt);
  const dateLabel = Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return dateLabel ? `${title} · ${dateLabel}` : title;
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
