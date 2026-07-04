/**
 * Shared chat surface pieces (assistant + playground): a transcript that keeps itself
 * scrolled to the newest message, user/assistant bubbles, a typing indicator for an
 * in-flight turn, and a composer that submits on Enter (Shift+Enter for a newline) and
 * clears after send. The routes own the data; this owns the conversational feel.
 */
import { useEffect, useRef, type ReactNode } from "react";
import { ArrowUp, Loader2 } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";

export function ChatTranscript({
  children,
  dep,
}: {
  children: ReactNode;
  /** Changes when new content lands — triggers the scroll-to-bottom. */
  dep: unknown;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [dep]);
  return (
    <div className="space-y-4">
      {children}
      <div ref={endRef} />
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
