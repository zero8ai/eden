/**
 * Shared chat surface pieces (assistant + playground): a transcript that keeps itself
 * scrolled to the newest message, user/assistant bubbles, and a composer that submits on
 * Enter (Shift+Enter for a newline) and clears after send. The routes own the data; this
 * owns the conversational feel.
 */
import { useEffect, useRef, type ReactNode } from "react";

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
    <div className="space-y-3">
      {children}
      <div ref={endRef} />
    </div>
  );
}

export function UserBubble({ text }: { text: string }) {
  return (
    <div className="ml-auto w-fit max-w-[85%] rounded-xl bg-primary px-4 py-2.5 text-sm text-primary-foreground">
      <p className="whitespace-pre-wrap">{text}</p>
    </div>
  );
}

export function AssistantBubble({ children }: { children: ReactNode }) {
  return (
    <div className="w-fit max-w-[85%] rounded-xl border bg-card px-4 py-2.5 text-sm">
      {children}
    </div>
  );
}

/** A subdued bubble shown while the assistant turn is in flight. */
export function PendingBubble({ label }: { label: string }) {
  return (
    <div className="w-fit max-w-[85%] rounded-xl border border-dashed bg-card px-4 py-2.5 text-sm text-muted-foreground">
      {label}
    </div>
  );
}

export function ChatComposer({
  placeholder,
  busy,
  busyLabel,
  onSend,
  extras,
}: {
  placeholder: string;
  busy: boolean;
  busyLabel: string;
  onSend: (message: string) => void;
  /** Optional controls rendered next to the send button (e.g. a deployment picker). */
  extras?: ReactNode;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  const send = () => {
    const message = ref.current?.value.trim();
    if (!message || busy) return;
    onSend(message);
    if (ref.current) ref.current.value = "";
  };

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-xl border bg-card p-3">
      <div className="min-w-0 flex-1">
        <Textarea
          ref={ref}
          placeholder={placeholder}
          aria-label={placeholder}
          className="min-h-16 resize-none border-0 p-2 shadow-none focus-visible:ring-0"
          disabled={busy}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
      </div>
      <div className="flex flex-col items-stretch gap-2">
        {extras}
        <Button onClick={send} disabled={busy}>
          {busy ? busyLabel : "Send"}
        </Button>
      </div>
    </div>
  );
}
