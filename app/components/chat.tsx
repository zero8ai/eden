/**
 * Shared chat surface pieces (assistant + playground): a transcript that owns its scroll
 * region and keeps itself pinned to the newest message (unless the user scrolls up to
 * read), user/assistant bubbles, a typing indicator for an in-flight turn, a collapsible
 * steps card for agent tool activity, and a composer that submits on Enter (Shift+Enter
 * for a newline) and clears after send. The routes own the data; this owns the
 * conversational feel.
 */
import { useEffect, useRef, type ReactNode } from "react";
import { ArrowUp, ChevronRight, Loader2 } from "lucide-react";

import type { ChatInputRequest, ChatStep } from "~/chat/types";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";

/** How close to the bottom (px) still counts as "pinned" — scrolling further up pauses
 * auto-scroll until the user returns to the bottom. */
const PIN_THRESHOLD = 60;

export function ChatTranscript({
  children,
  lead,
  dep,
}: {
  children: ReactNode;
  /** Page intro (title, alerts, …) that scrolls away with the conversation. */
  lead?: ReactNode;
  /** Changes when new content lands — triggers the scroll-to-bottom. */
  dep: unknown;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [dep]);
  return (
    // Full-bleed scroll region (content centered inside) so the wheel works anywhere
    // across the viewport, not just over the centered column.
    <div
      ref={ref}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      onScroll={(e) => {
        const el = e.currentTarget;
        pinnedRef.current =
          el.scrollHeight - el.scrollTop - el.clientHeight < PIN_THRESHOLD;
      }}
    >
      <div className="mx-auto w-full max-w-5xl px-6 pt-6">
        {lead}
        <div className="space-y-4 pb-2">{children}</div>
      </div>
    </div>
  );
}

export function UserBubble({ text }: { text: string }) {
  return (
    <div className="ml-auto w-fit max-w-[85%] rounded-2xl bg-primary px-4 py-2.5 text-sm text-primary-foreground">
      <p className="whitespace-pre-wrap">{text}</p>
    </div>
  );
}

export function AssistantBubble({ children }: { children: ReactNode }) {
  return (
    <div className="w-fit max-w-[85%] rounded-2xl border bg-card px-4 py-2.5 text-sm">
      {children}
    </div>
  );
}

/**
 * Pending agent input requests (ask_question / tool approvals), rendered as distinct
 * callouts inside the assistant bubble so a question never gets lost after a reply that
 * trails off with "one decision for you:". Multiple-choice questions and approvals render
 * their options as buttons — clicking one sends the option as the answer (eve resolves a
 * follow-up matching an option's id/label). Pass `onAnswer` only where answering makes
 * sense (the newest turn); without it the options render as a static record.
 */
export function InputRequestsBlock({
  requests,
  onAnswer,
  busy,
}: {
  requests: ChatInputRequest[];
  onAnswer?: (text: string) => void;
  busy?: boolean;
}) {
  if (requests.length === 0) return null;
  return (
    <div className="mt-2 space-y-2">
      {requests.map((request) => (
        <div
          key={request.requestId}
          className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2"
        >
          <p className="text-xs font-medium text-primary">
            {request.display === "confirmation"
              ? "The agent needs your approval"
              : "The agent is waiting for your answer"}
          </p>
          <p className="mt-1 whitespace-pre-wrap">{request.prompt}</p>
          {request.options && request.options.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {request.options.map((option) => (
                <Button
                  key={option.id}
                  type="button"
                  size="sm"
                  variant={
                    option.style === "danger"
                      ? "destructive"
                      : option.style === "primary"
                        ? "default"
                        : "outline"
                  }
                  disabled={!onAnswer || busy}
                  title={option.description ?? undefined}
                  onClick={() => onAnswer?.(option.label)}
                >
                  {option.label}
                </Button>
              ))}
            </div>
          )}
          {onAnswer && (request.allowFreeform || !request.options?.length) && (
            <p className="mt-2 text-xs text-muted-foreground">
              {request.options?.length
                ? "Or type your own answer below."
                : "Type your answer below."}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

/** Typing indicator shown while the assistant turn is in flight — dots, not prose, so it
 * never reads like a real reply. */
export function PendingBubble() {
  return (
    <div className="w-fit rounded-2xl border bg-card px-4 py-3">
      <div className="flex items-center gap-1" aria-hidden="true">
        <span className="size-1.5 animate-pulse rounded-full bg-muted-foreground/60 [animation-delay:-0.3s]" />
        <span className="size-1.5 animate-pulse rounded-full bg-muted-foreground/60 [animation-delay:-0.15s]" />
        <span className="size-1.5 animate-pulse rounded-full bg-muted-foreground/60" />
      </div>
      <span className="sr-only">Working…</span>
    </div>
  );
}

/**
 * The agent's work for one turn, as its own collapsed card next to the reply bubble.
 * Collapsed it reads as a summary ("4 steps · 12.3s"); expanded it lists each step's
 * tool + summary with duration/tokens, and failed steps surface their detail. During a
 * live turn, pass `activity` — the header shows a spinner with what the agent is doing
 * right now instead of the summary.
 */
export function StepsCard({
  steps,
  idPrefix,
  activity,
}: {
  steps: ChatStep[];
  idPrefix: string;
  /** Live turns: the agent's current activity, shown with a spinner in the header. */
  activity?: string | null;
}) {
  if (steps.length === 0 && !activity) return null;
  const totalMs = steps.reduce((sum, s) => sum + (s.durationMs ?? 0), 0);
  const failed = steps.some((s) => s.isError);
  return (
    <details className="group w-fit max-w-[85%] rounded-xl border bg-muted/40 text-xs text-muted-foreground">
      <summary className="flex cursor-pointer select-none items-center gap-2 px-3 py-2 [&::-webkit-details-marker]:hidden">
        <ChevronRight
          className="size-3.5 shrink-0 transition-transform group-open:rotate-90"
          aria-hidden
        />
        {activity ? (
          <span className="flex min-w-0 items-center gap-1.5">
            <Loader2 className="size-3 shrink-0 animate-spin" />
            <span className="truncate font-mono">{activity}</span>
            {steps.length > 0 && (
              <span className="shrink-0 text-muted-foreground/70">
                · {steps.length} step{steps.length === 1 ? "" : "s"}
              </span>
            )}
          </span>
        ) : (
          <span>
            {steps.length} step{steps.length === 1 ? "" : "s"}
            {totalMs > 0 ? ` · ${(totalMs / 1000).toFixed(1)}s` : ""}
            {failed ? " · failed" : ""}
          </span>
        )}
      </summary>
      {steps.length > 0 && (
        <ul className="space-y-1 border-t px-3 py-2">
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
      )}
    </details>
  );
}

const MAX_COMPOSER_HEIGHT = 192;

/** Grow the textarea to fit its content, up to a cap (then it scrolls). */
function autoGrow(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, MAX_COMPOSER_HEIGHT)}px`;
}

export function ChatComposer({
  placeholder,
  busy,
  onSend,
  controls,
}: {
  placeholder: string;
  busy: boolean;
  onSend: (message: string) => void;
  /** Optional controls rendered in the toolbar, left of the send button (e.g. a picker). */
  controls?: ReactNode;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  const send = () => {
    const message = ref.current?.value.trim();
    if (!message || busy) return;
    onSend(message);
    if (ref.current) {
      ref.current.value = "";
      ref.current.style.height = "auto";
    }
  };

  return (
    <div className="rounded-2xl border bg-card shadow-sm transition focus-within:border-ring focus-within:ring-1 focus-within:ring-ring">
      <Textarea
        ref={ref}
        placeholder={placeholder}
        aria-label={placeholder}
        rows={1}
        className="max-h-48 min-h-11 resize-none border-0 bg-transparent px-4 py-3 text-sm shadow-none focus-visible:ring-0 disabled:bg-transparent dark:bg-transparent dark:disabled:bg-transparent"
        disabled={busy}
        onInput={(e) => autoGrow(e.currentTarget)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
      />
      <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5">
        <div className="flex min-w-0 items-center gap-2">{controls}</div>
        <Button
          type="button"
          size="icon"
          className="size-9 shrink-0 rounded-full"
          onClick={send}
          disabled={busy}
          aria-label="Send"
        >
          {busy ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <ArrowUp className="size-4" />
          )}
        </Button>
      </div>
    </div>
  );
}
