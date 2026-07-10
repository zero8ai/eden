/**
 * Shared chat surface pieces (assistant + playground): a transcript that owns its scroll
 * region and keeps itself pinned to the newest message (unless the user scrolls up to
 * read), user/assistant bubbles, a typing indicator for an in-flight turn, a collapsible
 * steps card for agent tool activity, and a composer that submits on Enter (Shift+Enter
 * for a newline) and clears after send. The routes own the data; this owns the
 * conversational feel.
 */
import { useEffect, useMemo, useRef, type ReactNode } from "react";
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
  forceScrollDep,
}: {
  children: ReactNode;
  /** Page intro (title, alerts, …) that scrolls away with the conversation. */
  lead?: ReactNode;
  /** Changes when new content lands — triggers the scroll-to-bottom. */
  dep: unknown;
  /** Changes when user intent should force the newest message into view. */
  forceScrollDep?: unknown;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const scrollToBottom = () => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  };
  useEffect(() => {
    if (pinnedRef.current) scrollToBottom();
  }, [dep]);
  useEffect(() => {
    if (forceScrollDep == null || forceScrollDep === "") return;
    pinnedRef.current = true;
    scrollToBottom();
  }, [forceScrollDep]);
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
      <div className="mx-auto w-full max-w-5xl px-4 pt-6 sm:px-6">
        {lead}
        <div className="space-y-4 pb-2">{children}</div>
      </div>
    </div>
  );
}

export function UserBubble({ text }: { text: string }) {
  return (
    <div className="ml-auto w-fit max-w-[85%] rounded-2xl bg-muted px-4 py-2.5 text-sm text-foreground">
      <p className="whitespace-pre-wrap">{text}</p>
    </div>
  );
}

export function AssistantBubble({ children }: { children: ReactNode }) {
  return (
    <div className="w-fit max-w-[85%] rounded-2xl border border-l-2 border-primary/20 border-l-primary/50 bg-card px-4 py-2.5 text-sm">
      {children}
    </div>
  );
}

type MarkdownBlock =
  | { id: string; type: "paragraph"; text: string }
  | { id: string; type: "heading"; level: 1 | 2 | 3 | 4; text: string }
  | { id: string; type: "code"; language: string | null; code: string }
  | { id: string; type: "list"; ordered: boolean; items: MarkdownListItem[] }
  | { id: string; type: "quote"; text: string }
  | { id: string; type: "rule" };

type MarkdownListItem = { id: string; text: string };

type InlineToken =
  | { id: string; type: "text"; text: string }
  | { id: string; type: "line-break" }
  | { id: string; type: "code"; text: string }
  | { id: string; type: "strong"; text: string }
  | { id: string; type: "emphasis"; text: string }
  | { id: string; type: "link"; label: string; href: string | null };

const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

export function MarkdownText({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdownBlocks(text), [text]);
  return (
    <div className="space-y-2 break-words">
      {blocks.map((block) => (
        <MarkdownBlockView key={block.id} block={block} />
      ))}
    </div>
  );
}

function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let blockId = 0;

  const nextId = (prefix: string) => `${prefix}-${blockId++}`;

  const flushParagraph = () => {
    const text = paragraph.join("\n").trim();
    if (text) blocks.push({ id: nextId("p"), type: "paragraph", text });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph();
      continue;
    }

    const fence = trimmed.match(/^```([\w-]+)?\s*$/);
    if (fence) {
      flushParagraph();
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        code.push(lines[i]);
        i += 1;
      }
      blocks.push({
        id: nextId("code"),
        type: "code",
        language: fence[1] ?? null,
        code: code.join("\n"),
      });
      continue;
    }

    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      blocks.push({
        id: nextId("h"),
        type: "heading",
        level: heading[1].length as 1 | 2 | 3 | 4,
        text: heading[2].trim(),
      });
      continue;
    }

    if (/^([-*_])(?:\s*\1){2,}\s*$/.test(trimmed)) {
      flushParagraph();
      blocks.push({ id: nextId("rule"), type: "rule" });
      continue;
    }

    const unordered = trimmed.match(/^[-*+]\s+(.+)$/);
    const ordered = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      const isOrdered = ordered !== null;
      const items: MarkdownListItem[] = [];
      while (i < lines.length) {
        const current = lines[i].trim();
        const item = isOrdered
          ? current.match(/^\d+[.)]\s+(.+)$/)
          : current.match(/^[-*+]\s+(.+)$/);
        if (!item) break;
        items.push({ id: nextId("li"), text: item[1] });
        i += 1;
      }
      i -= 1;
      blocks.push({
        id: nextId(isOrdered ? "ol" : "ul"),
        type: "list",
        ordered: isOrdered,
        items,
      });
      continue;
    }

    if (trimmed.startsWith(">")) {
      flushParagraph();
      const quote: string[] = [];
      while (i < lines.length) {
        const current = lines[i].trim();
        if (!current.startsWith(">")) break;
        quote.push(current.replace(/^>\s?/, ""));
        i += 1;
      }
      i -= 1;
      blocks.push({
        id: nextId("quote"),
        type: "quote",
        text: quote.join("\n").trim(),
      });
      continue;
    }

    paragraph.push(line);
  }

  flushParagraph();
  return blocks;
}

function MarkdownBlockView({ block }: { block: MarkdownBlock }) {
  switch (block.type) {
    case "heading": {
      const className =
        block.level <= 2
          ? "pt-1 text-base font-semibold leading-snug"
          : "pt-1 text-sm font-semibold leading-snug";
      if (block.level === 1)
        return (
          <h3 className={className}>
            <InlineMarkdown text={block.text} idPrefix={block.id} />
          </h3>
        );
      if (block.level === 2)
        return (
          <h4 className={className}>
            <InlineMarkdown text={block.text} idPrefix={block.id} />
          </h4>
        );
      return (
        <h5 className={className}>
          <InlineMarkdown text={block.text} idPrefix={block.id} />
        </h5>
      );
    }
    case "code":
      return (
        <pre className="max-w-full overflow-x-auto rounded-lg bg-muted/60 p-3 font-mono text-xs leading-relaxed">
          <code>{block.code}</code>
        </pre>
      );
    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return (
        <Tag
          className={`${block.ordered ? "list-decimal" : "list-disc"} space-y-1 pl-5 leading-relaxed`}
        >
          {block.items.map((item) => (
            <li key={item.id}>
              <InlineMarkdown text={item.text} idPrefix={item.id} />
            </li>
          ))}
        </Tag>
      );
    }
    case "quote":
      return (
        <blockquote className="border-l-2 border-muted-foreground/30 pl-3 text-muted-foreground">
          <InlineMarkdown text={block.text} idPrefix={block.id} />
        </blockquote>
      );
    case "rule":
      return <hr className="border-border" />;
    case "paragraph":
      return (
        <p className="whitespace-pre-wrap leading-relaxed">
          <InlineMarkdown text={block.text} idPrefix={block.id} />
        </p>
      );
  }
}

function InlineMarkdown({
  text,
  idPrefix,
}: {
  text: string;
  idPrefix: string;
}) {
  const tokens = useMemo(
    () => parseInlineMarkdown(text, idPrefix),
    [idPrefix, text],
  );
  return (
    <>
      {tokens.map((token) => (
        <InlineTokenView key={token.id} token={token} />
      ))}
    </>
  );
}

function parseInlineMarkdown(text: string, keyPrefix: string): InlineToken[] {
  const pattern =
    /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\[[^\]]+\]\([^)]+\)|\*[^*\s][^*]*\*|_[^_\s][^_]*_|\n)/g;
  const tokens: InlineToken[] = [];
  let cursor = 0;
  let part = 0;

  const nextId = (prefix: string) => `${keyPrefix}-${prefix}-${part++}`;

  for (const match of text.matchAll(pattern)) {
    const token = match[0];
    const start = match.index ?? 0;
    if (start > cursor) {
      tokens.push({
        id: nextId("text"),
        type: "text",
        text: text.slice(cursor, start),
      });
    }

    if (token === "\n") {
      tokens.push({ id: nextId("br"), type: "line-break" });
    } else if (token.startsWith("`")) {
      tokens.push({
        id: nextId("code"),
        type: "code",
        text: token.slice(1, -1),
      });
    } else if (token.startsWith("**") || token.startsWith("__")) {
      tokens.push({
        id: nextId("strong"),
        type: "strong",
        text: token.slice(2, -2),
      });
    } else if (token.startsWith("[")) {
      tokens.push(parseLinkToken(token, nextId("link")));
    } else {
      tokens.push({
        id: nextId("em"),
        type: "emphasis",
        text: token.slice(1, -1),
      });
    }

    cursor = start + token.length;
  }

  if (cursor < text.length) {
    tokens.push({ id: nextId("text"), type: "text", text: text.slice(cursor) });
  }
  return tokens;
}

function InlineTokenView({ token }: { token: InlineToken }) {
  switch (token.type) {
    case "text":
      return <>{token.text}</>;
    case "line-break":
      return <br />;
    case "code":
      return (
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.88em]">
          {token.text}
        </code>
      );
    case "strong":
      return (
        <strong>
          <InlineMarkdown text={token.text} idPrefix={token.id} />
        </strong>
      );
    case "emphasis":
      return (
        <em>
          <InlineMarkdown text={token.text} idPrefix={token.id} />
        </em>
      );
    case "link":
      return <MarkdownLink token={token} />;
  }
}

function parseLinkToken(token: string, id: string): InlineToken {
  const match = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
  if (!match) return { id, type: "text", text: token };
  const label = match[1];
  const href = safeHref(match[2].trim());
  return { id, type: "link", label, href };
}

function MarkdownLink({
  token,
}: {
  token: Extract<InlineToken, { type: "link" }>;
}) {
  if (!token.href) return <>{token.label}</>;
  return (
    <a
      href={token.href}
      target={token.href.startsWith("/") ? undefined : "_blank"}
      rel={token.href.startsWith("/") ? undefined : "noreferrer"}
      className="font-medium underline underline-offset-4"
    >
      <InlineMarkdown text={token.label} idPrefix={token.id} />
    </a>
  );
}

function safeHref(value: string): string | null {
  if (value.startsWith("/")) return value;
  try {
    const url = new URL(value);
    return SAFE_LINK_PROTOCOLS.has(url.protocol) ? value : null;
  } catch {
    return null;
  }
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
    <div className="w-fit rounded-2xl border border-l-2 border-primary/20 border-l-primary/50 bg-card px-4 py-3">
      <div className="flex items-center gap-1" aria-hidden="true">
        <span className="size-1.5 animate-pulse rounded-full bg-primary/70 [animation-delay:-0.3s]" />
        <span className="size-1.5 animate-pulse rounded-full bg-primary/70 [animation-delay:-0.15s]" />
        <span className="size-1.5 animate-pulse rounded-full bg-primary/70" />
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
    <details className="group w-fit max-w-[85%] rounded-xl border border-l-2 border-l-blue-500/50 bg-muted/40 text-xs text-muted-foreground">
      <summary className="flex cursor-pointer select-none items-center gap-2 px-3 py-2 [&::-webkit-details-marker]:hidden">
        <ChevronRight
          className="size-3.5 shrink-0 text-blue-600 transition-transform group-open:rotate-90 dark:text-blue-400"
          aria-hidden
        />
        {activity ? (
          <span className="flex min-w-0 items-center gap-1.5">
            <Loader2 className="size-3 shrink-0 animate-spin text-blue-600 dark:text-blue-400" />
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
  disabled = false,
  onSend,
  controls,
}: {
  placeholder: string;
  busy: boolean;
  /** Disable composing without showing the in-flight spinner used for `busy`. */
  disabled?: boolean;
  onSend: (message: string) => void;
  /** Optional controls rendered in the toolbar, left of the send button (e.g. a picker). */
  controls?: ReactNode;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const unavailable = busy || disabled;

  const send = () => {
    const message = ref.current?.value.trim();
    if (!message || unavailable) return;
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
        disabled={unavailable}
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
          disabled={unavailable}
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
