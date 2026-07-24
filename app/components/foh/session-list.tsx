/**
 * FOH middle pane — one agent's sessions, needs-you first (the server sorts; this renders).
 * Rows show the status dot + relative time per the §3 mock, an unread marker, and an
 * "opened by agent" hint for delegation-parked sessions. Minimal keyboard nav: focus the
 * list, j/k (or arrows) to move, Enter to open.
 */
import { useState } from "react";
import { NavLink, useNavigate } from "react-router";

import { relativeTimeLabel } from "~/components/foh/relative-time";
import { cn } from "~/lib/utils";

export interface FohSessionRow {
  id: string;
  title: string;
  fohStatus: "working" | "needs_you" | "done" | "error";
  updatedAt: string;
  unread?: boolean;
  openedByAgent?: boolean;
}

const STATUS_LABEL: Record<FohSessionRow["fohStatus"], string> = {
  working: "working",
  needs_you: "needs you",
  done: "done",
  error: "failed",
};

export function SessionStatusDot({
  status,
}: {
  status: FohSessionRow["fohStatus"];
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-2 shrink-0 rounded-full",
        status === "working" && "animate-pulse bg-blue-500",
        status === "needs_you" && "bg-amber-500",
        status === "done" && "bg-muted-foreground/40",
        status === "error" && "bg-destructive",
      )}
    />
  );
}

export function SessionList({
  sessions,
  basePath,
  selectedId,
}: {
  sessions: FohSessionRow[];
  /** `/t/:projectId/:agentId` — rows link under it (D14). */
  basePath: string;
  selectedId?: string | null;
}) {
  const navigate = useNavigate();
  const [cursor, setCursor] = useState(() =>
    Math.max(
      0,
      sessions.findIndex((session) => session.id === selectedId),
    ),
  );

  const move = (delta: number) =>
    setCursor((prev) =>
      Math.min(sessions.length - 1, Math.max(0, prev + delta)),
    );

  return (
    <ul
      tabIndex={0}
      aria-label="Sessions"
      className="flex-1 divide-y overflow-y-auto outline-none focus-visible:ring-1 focus-visible:ring-ring"
      onKeyDown={(e) => {
        if (e.key === "j" || e.key === "ArrowDown") {
          e.preventDefault();
          move(1);
        } else if (e.key === "k" || e.key === "ArrowUp") {
          e.preventDefault();
          move(-1);
        } else if (e.key === "Enter") {
          const session = sessions[cursor];
          if (session) navigate(`${basePath}/s/${session.id}`);
        }
      }}
    >
      {sessions.map((session, i) => (
        <li key={session.id}>
          <NavLink
            to={`${basePath}/s/${session.id}`}
            prefetch="intent"
            className={({ isActive }) =>
              cn(
                "flex items-start gap-2 px-3 py-2.5 transition-colors hover:bg-muted/60",
                isActive && "bg-muted",
                i === cursor && "ring-1 ring-inset ring-ring/40",
              )
            }
            onClick={() => setCursor(i)}
          >
            <span className="mt-1.5">
              <SessionStatusDot status={session.fohStatus} />
            </span>
            <span className="min-w-0 flex-1">
              <span
                className={cn(
                  "block truncate text-sm",
                  session.unread ? "font-semibold" : "font-normal",
                )}
              >
                {session.title}
              </span>
              <span className="block text-xs text-muted-foreground">
                {STATUS_LABEL[session.fohStatus]} ·{" "}
                {relativeTimeLabel(session.updatedAt)}
                {session.openedByAgent && " · opened by the agent"}
                {session.unread && (
                  <span className="ml-1 inline-block size-1.5 rounded-full bg-blue-500 align-middle" />
                )}
              </span>
            </span>
          </NavLink>
        </li>
      ))}
    </ul>
  );
}
