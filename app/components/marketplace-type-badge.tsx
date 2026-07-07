import {
  Bot,
  Hash,
  Plug,
  Sparkles,
  Workflow,
  Wrench,
  type LucideIcon,
} from "lucide-react";

import { accentChip, type Accent } from "~/components/shell";
import type { TemplateType } from "~/marketplace/manifest";

/**
 * Per-type presentation for marketplace templates — the single source of truth shared by the
 * template detail page and the install wizard, and kept in lockstep with the catalog browse
 * cards (marketplace.tsx TYPE_META). A template's kind reads by the same icon + accent colour
 * everywhere it appears.
 */
export const TYPE_META: Record<
  TemplateType,
  { label: string; icon: LucideIcon; accent: Accent }
> = {
  agent: { label: "Agent", icon: Bot, accent: "violet" },
  tool: { label: "Tool", icon: Wrench, accent: "blue" },
  skill: { label: "Skill", icon: Sparkles, accent: "amber" },
  subagent: { label: "Subagent", icon: Workflow, accent: "fuchsia" },
  channel: { label: "Channel", icon: Hash, accent: "emerald" },
  connection: { label: "Connection", icon: Plug, accent: "cyan" },
};

/** A coloured icon + label chip marking a template's type (matches the catalog + detail + install). */
export function TypeBadge({ type }: { type: TemplateType }) {
  const meta = TYPE_META[type];
  const Icon = meta.icon;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ${accentChip[meta.accent]}`}
    >
      <Icon className="size-3" />
      {meta.label}
    </span>
  );
}
