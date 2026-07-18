/**
 * Agent Portal chat page (issue #180) — the public, GPT-like surface at /a/:slug, completely
 * outside the Eden app shell: session sidebar, message list, composer, nothing else.
 *
 * Access: a Better Auth session + a live grant on THIS portal (email OTP sign-in; org
 * membership is never consulted). Turns POST to the portal stream route and read back the same
 * NDJSON feed as the playground.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  data,
  redirect,
  useFetcher,
  useNavigate,
  useRevalidator,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";
import { Plus, Square } from "lucide-react";

import { getSessionAuth } from "~/auth/session.server";
import { liveTargets } from "~/chat/playground.server";
import type { ChatEntry, ChatInputRequest, ChatStep } from "~/chat/types";
import {
  AssistantBubble,
  ChatComposer,
  ChatTranscript,
  InputRequestsBlock,
  MarkdownText,
  StepsCard,
  UserBubble,
} from "~/components/chat";
import { TurnError } from "~/components/turn-error";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { authClient } from "~/lib/auth-client";
import { cn } from "~/lib/utils";
import { noindexMeta } from "~/lib/seo";
import {
  cacheCoversCompletedLiveTurn,
  liveTurnIsForDifferentSession,
  shouldPollRemoteSession,
} from "~/playground/handoff";
import {
  createPlaygroundSession,
  getPlaygroundSession,
  listPlaygroundSessions,
  loadPlaygroundEntriesFromCache,
  reconcilePlaygroundSessionFromEve,
  settleAbandonedPlaygroundSession,
  summarizePlaygroundSession,
  type PlaygroundSession,
} from "~/playground/sessions.server";
import { findSessionOwnerTarget } from "~/playground/ownership";
import { shouldSettleAbandonedSession } from "~/playground/settle";
import { hasActiveTurn, TURN_IDLE_TIMEOUT_MS } from "~/chat/turn-stream.server";
import { requirePortalBySlug, resolvePortalAccess } from "~/portal/guard.server";
import type { ReasoningEffort } from "~/models/reasoning";
import type { Route } from "./+types/a.$slug";

type SessionSummary = {
  id: string;
  title: string;
  status: string;
  updatedAt: string;
};

export async function loader(args: LoaderFunctionArgs) {
  const portal = await requirePortalBySlug(args.params.slug);
  const session = await getSessionAuth(args);
  const access = await resolvePortalAccess(session, portal);
  const shell = { portalName: portal.name, slug: portal.slug };
  if (access.state !== "granted") {
    return {
      ...shell,
      access: access.state,
      email: access.state === "denied" ? access.email : null,
      online: false,
      sessions: [] as SessionSummary[],
      currentSessionId: null as string | null,
      currentSessionStatus: null as string | null,
      entries: [] as ChatEntry[],
    };
  }

  const [targets, sessions] = await Promise.all([
    liveTargets(portal.agentId),
    listPlaygroundSessions({
      projectId: portal.projectId,
      agentId: portal.agentId,
      userId: access.userId,
      portalId: portal.id,
    }),
  ]);
  const selectedSessionId = new URL(args.request.url).searchParams.get("session");
  let currentSession: PlaygroundSession | null =
    (selectedSessionId
      ? (sessions.find((s) => s.id === selectedSessionId) ?? null)
      : null) ??
    sessions[0] ??
    null;

  if (currentSession) {
    // Same dead-drain recovery as the playground: a turn whose drain died with the Eden
    // process must not leave the conversation reading "busy" forever.
    const ownerTarget = findSessionOwnerTarget(currentSession, targets);
    if (
      (currentSession.status === "running" ||
        currentSession.status === "failed") &&
      ownerTarget &&
      !hasActiveTurn(currentSession.id)
    ) {
      try {
        currentSession = await reconcilePlaygroundSessionFromEve({
          session: currentSession,
          target: ownerTarget,
        });
      } catch {
        // Eve unreachable — a later load retries.
      }
    }
    if (
      shouldSettleAbandonedSession({
        status: currentSession.status,
        activeTurnInProcess: hasActiveTurn(currentSession.id),
        ownerDeploymentLive: ownerTarget !== null,
        msSinceLastActivity: Date.now() - currentSession.updatedAt.getTime(),
        idleTimeoutMs: TURN_IDLE_TIMEOUT_MS,
      })
    ) {
      currentSession = await settleAbandonedPlaygroundSession(currentSession);
    }
  }

  return {
    ...shell,
    access: "granted" as const,
    email: access.email,
    online: targets.length > 0,
    sessions: sessions.map((s) => {
      const summary = summarizePlaygroundSession(s);
      return {
        id: summary.id,
        title: summary.title,
        status: summary.status,
        updatedAt: summary.updatedAt,
      } satisfies SessionSummary;
    }),
    currentSessionId: currentSession?.id ?? null,
    currentSessionStatus: currentSession?.status ?? null,
    entries: currentSession
      ? await loadPlaygroundEntriesFromCache(currentSession)
      : ([] as ChatEntry[]),
  };
}

export async function action(args: ActionFunctionArgs) {
  const portal = await requirePortalBySlug(args.params.slug);
  const session = await getSessionAuth(args);
  const access = await resolvePortalAccess(session, portal);
  if (access.state !== "granted") {
    throw redirect(`/a/${encodeURIComponent(portal.slug)}`);
  }
  const form = await args.request.formData();
  if (String(form.get("intent")) === "new-session") {
    // Row-spam guard: turns are rate-limited, but empty conversations would not be.
    const existing = await listPlaygroundSessions({
      projectId: portal.projectId,
      agentId: portal.agentId,
      userId: access.userId,
      portalId: portal.id,
    });
    if (existing.length >= 100) {
      throw data(
        { error: "Conversation limit reached for this portal." },
        { status: 429 },
      );
    }
    const created = await createPlaygroundSession({
      projectId: portal.projectId,
      agentId: portal.agentId,
      userId: access.userId,
      portalId: portal.id,
      modelId: portal.modelId,
      effort: (portal.effort as ReasoningEffort | null) ?? null,
    });
    throw redirect(
      `/a/${encodeURIComponent(portal.slug)}?session=${encodeURIComponent(created.id)}`,
    );
  }
  return { ok: true as const };
}

export function meta({ loaderData }: Route.MetaArgs) {
  return [
    { title: loaderData ? `${loaderData.portalName} · eden` : "eden" },
    ...noindexMeta,
  ];
}

export default function PortalPage({ loaderData }: Route.ComponentProps) {
  if (loaderData.access !== "granted") {
    return (
      <PortalGate
        slug={loaderData.slug}
        portalName={loaderData.portalName}
        deniedEmail={loaderData.access === "denied" ? loaderData.email : null}
      />
    );
  }
  return <PortalChat data={loaderData} />;
}

/* ── Guest sign-in (email → 6-digit code) ─────────────────────────────────── */

function PortalGate({
  slug,
  portalName,
  deniedEmail,
}: {
  slug: string;
  portalName: string;
  deniedEmail: string | null;
}) {
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (step === "code") codeRef.current?.focus();
  }, [step]);

  async function requestCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const value = String(form.get("email") ?? "")
      .trim()
      .toLowerCase();
    if (!value) return;
    setError(null);
    setPending(true);
    try {
      await authClient.emailOtp.sendVerificationOtp({
        email: value,
        type: "sign-in",
      });
    } catch {
      // Uniform response either way — no email enumeration.
    }
    setEmail(value);
    setPending(false);
    setStep("code");
  }

  async function verifyCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const otp = String(form.get("otp") ?? "").trim();
    if (!otp) return;
    setError(null);
    setPending(true);
    try {
      const result = await authClient.signIn.emailOtp({ email, otp });
      if (result.error) {
        setError(
          result.error.message ||
            "That code didn't work. Check it and try again.",
        );
        setPending(false);
        return;
      }
    } catch {
      setError("Something went wrong. Please try again.");
      setPending(false);
      return;
    }
    window.location.assign(`/a/${encodeURIComponent(slug)}`);
  }

  async function useDifferentEmail() {
    await authClient.signOut();
    window.location.reload();
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-6 py-12">
      <div className="w-full max-w-sm">
        <Card className="gap-6 [--card-spacing:--spacing(6)]">
          <CardHeader className="gap-1.5">
            <CardTitle className="text-lg">{portalName}</CardTitle>
            <CardDescription>
              {deniedEmail
                ? `${deniedEmail} does not have access to this portal.`
                : step === "email"
                  ? "Enter your email to get a one-time sign-in code."
                  : `If ${email} has access, a 6-digit code is on its way.`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {deniedEmail ? (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Ask the team that runs this agent to add your email to the
                  access list, or sign in with a different address.
                </p>
                <Button
                  type="button"
                  className="h-10 w-full"
                  onClick={useDifferentEmail}
                >
                  Use a different email
                </Button>
              </div>
            ) : step === "email" ? (
              <form onSubmit={requestCode} className="space-y-5">
                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    name="email"
                    type="email"
                    autoComplete="email"
                    className="h-10"
                    autoFocus
                    required
                  />
                </div>
                <Button type="submit" className="h-10 w-full" disabled={pending}>
                  {pending ? "Sending…" : "Send code"}
                </Button>
              </form>
            ) : (
              <form onSubmit={verifyCode} className="space-y-5">
                <div className="flex items-baseline justify-between gap-3 rounded-lg bg-muted/50 px-3 py-2 text-sm">
                  <span className="truncate text-muted-foreground" title={email}>
                    {email}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setError(null);
                      setStep("email");
                    }}
                    className="shrink-0 font-medium text-foreground underline decoration-muted-foreground/40 underline-offset-4 transition-colors hover:decoration-foreground"
                  >
                    Change
                  </button>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="otp">6-digit code</Label>
                  <Input
                    ref={codeRef}
                    id="otp"
                    name="otp"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    className="h-10 text-center font-mono text-lg tracking-[0.5em]"
                    required
                  />
                </div>
                {error && (
                  <p role="alert" className="text-sm text-destructive">
                    {error}
                  </p>
                )}
                <Button type="submit" className="h-10 w-full" disabled={pending}>
                  {pending ? "Verifying…" : "Sign in"}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
        <p className="mt-6 text-center text-xs text-muted-foreground">
          Powered by eden
        </p>
      </div>
    </main>
  );
}

/* ── Chat surface ─────────────────────────────────────────────────────────── */

/** Local mirror of an in-flight turn (same NDJSON contract as the playground). */
interface LiveTurn {
  portalSessionId: string | null;
  baseEntryCount: number;
  userText: string;
  text: string;
  steps: ChatStep[];
  activity: string | null;
  inputRequests: ChatInputRequest[];
  error: string | null;
  errorDetail: string | null;
  errorRetryable: boolean;
  done: boolean;
}

type StreamEvent =
  | { type: "session"; playgroundSessionId: string }
  | { type: "model"; modelId: string }
  | { type: "thinking" }
  | { type: "action"; toolName: string; summary: string | null }
  | { type: "text"; text: string }
  | { type: "step"; step: ChatStep }
  | { type: "input"; requests: ChatInputRequest[] }
  | {
      type: "done";
      ok: boolean;
      playgroundSessionId?: string;
      reply: string | null;
      structured: boolean;
      inputRequests?: ChatInputRequest[];
      error: string | null;
      errorDetail?: string | null;
      errorRetryable?: boolean;
    };

function reduceLive(prev: LiveTurn, evt: StreamEvent): LiveTurn {
  switch (evt.type) {
    case "session":
      return { ...prev, portalSessionId: evt.playgroundSessionId };
    case "thinking":
      return { ...prev, activity: "Thinking…" };
    case "action":
      return {
        ...prev,
        activity: evt.summary ? `${evt.toolName}: ${evt.summary}` : evt.toolName,
      };
    case "text":
      return { ...prev, text: evt.text };
    case "step":
      return { ...prev, steps: [...prev.steps, evt.step], activity: "Thinking…" };
    case "input":
      return {
        ...prev,
        inputRequests: [...prev.inputRequests, ...evt.requests],
        activity: null,
      };
    case "done":
      return {
        ...prev,
        text: evt.reply ?? prev.text,
        inputRequests:
          evt.inputRequests && evt.inputRequests.length > 0
            ? evt.inputRequests
            : prev.inputRequests,
        error: evt.error,
        errorDetail: evt.errorDetail ?? null,
        errorRetryable: evt.errorRetryable ?? false,
        activity: null,
        done: true,
      };
    default:
      return prev;
  }
}

function PortalChat({
  data,
}: {
  data: {
    portalName: string;
    slug: string;
    email: string | null;
    online: boolean;
    sessions: SessionSummary[];
    currentSessionId: string | null;
    currentSessionStatus: string | null;
    entries: ChatEntry[];
  };
}) {
  const {
    portalName,
    slug,
    email,
    online,
    sessions,
    currentSessionId,
    currentSessionStatus,
    entries,
  } = data;
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const newSessionFetcher = useFetcher();
  const NewSessionForm = newSessionFetcher.Form;

  const [live, setLive] = useState<LiveTurn | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  const stopRequestedRef = useRef(false);

  const liveSessionMismatch = live
    ? liveTurnIsForDifferentSession(live.portalSessionId, currentSessionId)
    : false;
  const liveCoveredByCache =
    live !== null &&
    cacheCoversCompletedLiveTurn({
      liveSessionId: live.portalSessionId,
      currentSessionId,
      currentSessionStatus,
      liveDone: live.done,
      baseEntryCount: live.baseEntryCount,
      entries,
    });
  const visibleLive = liveSessionMismatch || liveCoveredByCache ? null : live;
  const remoteBusy = currentSessionStatus === "running";
  const busy = (live !== null && !live.done) || remoteBusy;
  const pollRemoteSession = shouldPollRemoteSession(remoteBusy, visibleLive);
  const replayingRunningSession = remoteBusy && !visibleLive;

  useEffect(() => {
    if (!pollRemoteSession) return;
    const id = window.setInterval(() => {
      if (revalidator.state === "idle") void revalidator.revalidate();
    }, 2_000);
    return () => window.clearInterval(id);
  }, [pollRemoteSession, revalidator]);

  const shownEntries =
    visibleLive &&
    (!visibleLive.portalSessionId ||
      visibleLive.portalSessionId === currentSessionId) &&
    entries.length > visibleLive.baseEntryCount
      ? entries.slice(0, visibleLive.baseEntryCount)
      : entries;

  const send = useCallback(
    async (message: string) => {
      setSendError(null);
      stopRequestedRef.current = false;
      setLive({
        portalSessionId: currentSessionId,
        baseEntryCount: entries.length,
        userText: message,
        text: "",
        steps: [],
        activity: "Thinking…",
        inputRequests: [],
        error: null,
        errorDetail: null,
        errorRetryable: false,
        done: false,
      });
      const apply = (evt: StreamEvent) =>
        setLive((prev) => (prev ? reduceLive(prev, evt) : prev));

      const form = new FormData();
      form.set("message", message);
      if (currentSessionId) form.set("portalSessionId", currentSessionId);

      try {
        const controller = new AbortController();
        streamAbortRef.current = controller;
        const res = await fetch(
          `/api/portal/${encodeURIComponent(slug)}/stream`,
          { method: "POST", body: form, signal: controller.signal },
        );
        if (!res.ok) {
          const detail = (await res.json().catch(() => null)) as {
            error?: unknown;
          } | null;
          const errorMessage =
            typeof detail?.error === "string" ? detail.error : null;
          streamAbortRef.current = null;
          setLive(null);
          setSendError(errorMessage ?? `Sending failed (${res.status}).`);
          return;
        }
        if (!res.body) throw new Error("The stream returned no response body.");

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
            if (stopRequestedRef.current && evt.type === "done") continue;
            apply(evt);
          }
        }
        setLive((prev) =>
          prev && !prev.done ? { ...prev, activity: null, done: true } : prev,
        );
        await revalidator.revalidate();
        if (!currentSessionId && nextSessionId) {
          navigate(
            `/a/${encodeURIComponent(slug)}?session=${encodeURIComponent(nextSessionId)}`,
            { replace: true },
          );
        }
        streamAbortRef.current = null;
      } catch (error) {
        streamAbortRef.current = null;
        if (stopRequestedRef.current) {
          await revalidator.revalidate();
          setLive(null);
          stopRequestedRef.current = false;
          return;
        }
        setLive((prev) =>
          prev
            ? {
                ...prev,
                error: `Lost the live stream: ${(error as Error).message}`,
                errorDetail: null,
                errorRetryable: false,
                activity: null,
                done: true,
              }
            : prev,
        );
        setSendError(
          "The live view dropped — the reply may still have been recorded.",
        );
        await revalidator.revalidate();
      }
    },
    [currentSessionId, entries.length, navigate, revalidator, slug],
  );

  const stopTurn = useCallback(async () => {
    const portalSessionId = visibleLive?.portalSessionId ?? currentSessionId;
    if (!portalSessionId) return;
    setSendError(null);
    const form = new FormData();
    form.set("portalSessionId", portalSessionId);
    stopRequestedRef.current = true;
    try {
      const res = await fetch(`/api/portal/${encodeURIComponent(slug)}/stop`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`Stop failed (${res.status}).`);
      streamAbortRef.current?.abort();
      await revalidator.revalidate();
      setLive(null);
    } catch (error) {
      stopRequestedRef.current = false;
      setSendError((error as Error).message);
    }
  }, [currentSessionId, revalidator, slug, visibleLive?.portalSessionId]);

  async function signOut() {
    await authClient.signOut();
    window.location.reload();
  }

  const sessionList = (
    <nav className="flex-1 space-y-1 overflow-y-auto">
      {sessions.map((s) => (
        <button
          key={s.id}
          type="button"
          onClick={() =>
            navigate(
              `/a/${encodeURIComponent(slug)}?session=${encodeURIComponent(s.id)}`,
            )
          }
          disabled={busy}
          className={cn(
            "w-full truncate rounded-md px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-60",
            s.id === currentSessionId && "bg-accent text-foreground",
          )}
        >
          {s.title}
        </button>
      ))}
    </nav>
  );

  return (
    <div className="flex h-dvh flex-col bg-background">
      <header className="flex items-center justify-between gap-3 border-b px-4 py-3 sm:px-6">
        <h1 className="truncate text-sm font-semibold">{portalName}</h1>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="hidden truncate sm:inline" title={email ?? undefined}>
            {email}
          </span>
          <button
            type="button"
            onClick={signOut}
            className="font-medium text-foreground underline decoration-muted-foreground/40 underline-offset-4 transition-colors hover:decoration-foreground"
          >
            Sign out
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-64 shrink-0 flex-col gap-3 border-r p-3 md:flex">
          <NewSessionForm method="post">
            <input type="hidden" name="intent" value="new-session" />
            <Button
              type="submit"
              variant="outline"
              size="sm"
              className="w-full gap-1.5"
              disabled={busy || newSessionFetcher.state !== "idle"}
            >
              <Plus className="size-3.5" />
              New conversation
            </Button>
          </NewSessionForm>
          {sessionList}
        </aside>

        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <ChatTranscript
            dep={`${shownEntries.length}:${shownEntries.at(-1)?.text.length ?? 0}:${currentSessionStatus ?? ""}:${visibleLive ? visibleLive.text.length + visibleLive.steps.length : 0}`}
            forceScrollDep={visibleLive?.userText}
            lead={
              <>
                {!online && (
                  <Alert className="mb-4">
                    <AlertDescription>
                      This agent is offline right now. You can read past
                      conversations; sending a message will work once it is
                      back.
                    </AlertDescription>
                  </Alert>
                )}
                {sendError && (
                  <Alert variant="destructive" className="mb-4">
                    <AlertDescription>{sendError}</AlertDescription>
                  </Alert>
                )}
              </>
            }
          >
            {shownEntries.length === 0 && !visibleLive && !remoteBusy && (
              <p className="py-8 text-center text-sm text-muted-foreground">
                Say something to {portalName} — the conversation keeps its
                context across turns.
              </p>
            )}
            {shownEntries.map((e, i) =>
              e.role === "user" ? (
                <UserBubble key={e.id} text={e.text} />
              ) : (
                <PortalAgentEntry
                  key={e.id}
                  entry={e}
                  onAnswer={
                    i === shownEntries.length - 1 && !visibleLive
                      ? send
                      : undefined
                  }
                  onRetry={
                    i === shownEntries.length - 1 &&
                    !visibleLive &&
                    e.errorRetryable
                      ? () => {
                          const userText = [...shownEntries.slice(0, i)]
                            .reverse()
                            .find((x) => x.role === "user")?.text;
                          if (userText) send(userText);
                        }
                      : undefined
                  }
                  busy={busy}
                  running={
                    replayingRunningSession && i === shownEntries.length - 1
                  }
                />
              ),
            )}
            {replayingRunningSession &&
              shownEntries.at(-1)?.role !== "assistant" && (
                <StepsCard
                  steps={[]}
                  idPrefix="running-session"
                  activity="Still working…"
                />
              )}
            {visibleLive && (
              <>
                <UserBubble text={visibleLive.userText} />
                <div className="space-y-2">
                  {(visibleLive.text ||
                    visibleLive.error ||
                    visibleLive.inputRequests.length > 0) && (
                    <AssistantBubble>
                      {visibleLive.error ? (
                        <TurnError
                          message={visibleLive.error}
                          detail={visibleLive.errorDetail}
                          retryable={visibleLive.errorRetryable}
                          onRetry={() => send(visibleLive.userText)}
                          busy={busy}
                        />
                      ) : visibleLive.text ? (
                        <MarkdownText text={visibleLive.text} />
                      ) : null}
                      <InputRequestsBlock
                        requests={visibleLive.inputRequests}
                        busy
                      />
                    </AssistantBubble>
                  )}
                  <StepsCard
                    steps={visibleLive.steps}
                    idPrefix="live"
                    activity={visibleLive.done ? null : visibleLive.activity}
                  />
                </div>
              </>
            )}
          </ChatTranscript>

          <div className="mx-auto w-full max-w-5xl px-4 pb-2 pt-3 sm:px-6">
            <div className="mb-2 flex items-center gap-2 md:hidden">
              <NewSessionForm method="post" className="shrink-0">
                <input type="hidden" name="intent" value="new-session" />
                <Button
                  type="submit"
                  variant="outline"
                  size="sm"
                  disabled={busy || newSessionFetcher.state !== "idle"}
                >
                  <Plus className="size-3.5" />
                  New
                </Button>
              </NewSessionForm>
              <select
                aria-label="Conversation"
                className="h-9 w-full min-w-0 rounded-md border bg-background px-2 text-sm"
                value={currentSessionId ?? ""}
                disabled={busy}
                onChange={(e) =>
                  navigate(
                    `/a/${encodeURIComponent(slug)}?session=${encodeURIComponent(e.target.value)}`,
                  )
                }
              >
                {sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
              </select>
            </div>
            <ChatComposer
              placeholder={`Message ${portalName}...`}
              busy={busy}
              disabled={!online}
              onSend={send}
              controls={
                busy ? (
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    className="h-9 gap-1.5"
                    onClick={stopTurn}
                  >
                    <Square className="size-3.5" />
                    Stop
                  </Button>
                ) : undefined
              }
            />
            <p className="py-2 text-center text-[11px] leading-4 text-muted-foreground">
              Conversations are visible to the team running this agent. Powered
              by eden.
            </p>
          </div>
        </main>
      </div>
    </div>
  );
}

function PortalAgentEntry({
  entry,
  onAnswer,
  onRetry,
  busy,
  running,
}: {
  entry: ChatEntry;
  onAnswer?: (text: string) => void;
  onRetry?: () => void;
  busy?: boolean;
  running?: boolean;
}) {
  return (
    <div className="space-y-2">
      <AssistantBubble>
        {entry.error ? (
          <TurnError
            message={entry.error}
            detail={entry.errorDetail}
            retryable={entry.errorRetryable}
            onRetry={onRetry}
            busy={busy}
          />
        ) : entry.structured ? (
          <pre className="overflow-x-auto rounded-lg bg-muted/50 p-3 font-mono text-xs">
            {entry.text}
          </pre>
        ) : entry.text || !entry.inputRequests?.length ? (
          <MarkdownText text={entry.text || "(empty reply)"} />
        ) : null}
        {entry.inputRequests && (
          <InputRequestsBlock
            requests={entry.inputRequests}
            onAnswer={onAnswer}
            busy={busy}
          />
        )}
      </AssistantBubble>
      <StepsCard
        steps={entry.steps ?? []}
        idPrefix={entry.id}
        activity={running ? "Still working…" : undefined}
      />
    </div>
  );
}
