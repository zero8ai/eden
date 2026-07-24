/**
 * FOH presence dot (§3): ● live (pulsing while a turn is active), ○ idle/wakeable, red on
 * failed-only deployments. Presence copy stays "running/idle" — deployment status is routing
 * truth, not a promise of activity.
 */
import { cn } from "~/lib/utils";

import type { AgentPresence } from "~/foh/presence.server";

const LABELS: Record<AgentPresence, string> = {
  active_turn: "working on a turn",
  running: "running",
  idle: "idle",
  error: "deployment failed",
};

export function PresenceDot({ presence }: { presence: AgentPresence }) {
  return (
    <span
      role="img"
      aria-label={LABELS[presence]}
      title={LABELS[presence]}
      className={cn(
        "size-2 shrink-0 rounded-full",
        presence === "active_turn" && "animate-pulse bg-emerald-500",
        presence === "running" && "bg-emerald-500",
        presence === "idle" && "border border-muted-foreground/50 bg-transparent",
        presence === "error" && "bg-destructive",
      )}
    />
  );
}
