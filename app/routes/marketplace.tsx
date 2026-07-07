/**
 * Recruit — the marketplace catalog (PRD §7.8, Milestone 6 phase 1).
 *
 * The browse surface: the pitch, type filter tabs with counts, and a card per template linking
 * to its detail page. It lists from the catalog's `index.json` only (never file bodies) via the
 * CatalogSource seam — fixture-backed in dev, the eve OSS repo's `marketplace/` in production.
 *
 * The catalog is a remote/optional dependency, so an unreachable index is an expected state, not
 * a crash: the loader catches it and the page renders a friendly empty-state explaining the
 * EDEN_CATALOG_REPO pointer and the fixture fallback.
 */
import { authkitLoader } from "@workos-inc/authkit-react-router";
import {
  Bot,
  Hash,
  Plug,
  Sparkles,
  Workflow,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { Link, type LoaderFunctionArgs } from "react-router";

import { AppShell, PageHeader } from "~/components/shell";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { TEMPLATE_TYPES, type TemplateType } from "~/marketplace/manifest";
import { getRuntime } from "~/seams/index.server";
import { syncTenant } from "~/auth/tenant.server";
import type { Route } from "./+types/marketplace";

/**
 * Per-type presentation: a distinct icon + accent colour so a card's kind is scannable at a
 * glance (not just readable), and singular/plural labels for the badge vs the filter tabs and
 * grouped-section headers. `accent` styles the badge chip; `dot` is the solid swatch.
 */
interface TypeMeta {
  label: string;
  plural: string;
  icon: LucideIcon;
  accent: string;
  dot: string;
}
/**
 * Presentation order for the filter tabs and grouped "All" sections — a product ordering (most
 * recruited first), distinct from `TEMPLATE_TYPES` (which is the manifest/registry order). Any
 * type absent here would just be dropped from the UI, so it lists all of them.
 */
const DISPLAY_ORDER: TemplateType[] = [
  "agent",
  "skill",
  "channel",
  "tool",
  "subagent",
  "connection",
];

const TYPE_META: Record<TemplateType, TypeMeta> = {
  agent: {
    label: "Agent",
    plural: "Agents",
    icon: Bot,
    accent: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
    dot: "bg-violet-500",
  },
  tool: {
    label: "Tool",
    plural: "Tools",
    icon: Wrench,
    accent: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
    dot: "bg-blue-500",
  },
  skill: {
    label: "Skill",
    plural: "Skills",
    icon: Sparkles,
    accent: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    dot: "bg-amber-500",
  },
  subagent: {
    label: "Subagent",
    plural: "Subagents",
    icon: Workflow,
    accent: "bg-fuchsia-500/10 text-fuchsia-600 dark:text-fuchsia-400",
    dot: "bg-fuchsia-500",
  },
  channel: {
    label: "Channel",
    plural: "Channels",
    icon: Hash,
    accent: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    dot: "bg-emerald-500",
  },
  connection: {
    label: "Connection",
    plural: "Connections",
    icon: Plug,
    accent: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400",
    dot: "bg-cyan-500",
  },
};

export const loader = (args: LoaderFunctionArgs) =>
  authkitLoader(
    args,
    async ({ auth }) => {
      const { org } = await syncTenant(auth);
      try {
        const index = await getRuntime().catalog.index();
        return { org, templates: index.templates, catalogError: null as string | null };
      } catch (error) {
        // Unreachable catalog is an expected state — render an empty-state, don't 500.
        return {
          org,
          templates: [],
          catalogError: (error as Error).message,
        };
      }
    },
    { ensureSignedIn: true },
  );

export function meta() {
  return [
    { title: "Marketplace · Eden" },
    { name: "robots", content: "noindex, nofollow" },
  ];
}

export default function Marketplace({ loaderData }: Route.ComponentProps) {
  const { user, org, templates, catalogError } = loaderData;
  const [filter, setFilter] = useState<TemplateType | "all">("all");

  const counts = TEMPLATE_TYPES.reduce(
    (acc, t) => {
      acc[t] = templates.filter((tpl) => tpl.type === t).length;
      return acc;
    },
    {} as Record<TemplateType, number>,
  );
  const shown =
    filter === "all" ? templates : templates.filter((t) => t.type === filter);

  return (
    <AppShell workspaceName={org?.name} userEmail={user.email}>
      <PageHeader
        title="Marketplace"
        description="Recruit pre-built tools, skills, and agents — instantiate an expert-authored template instead of writing one from scratch."
      />

      {catalogError ? (
        <Card className="border-dashed">
          <CardHeader className="items-center py-12 text-center">
            <CardTitle className="text-lg">Catalog unavailable</CardTitle>
            <CardDescription className="max-w-lg">
              Eden couldn&rsquo;t reach the template catalog. In development it reads
              the in-repo <span className="font-mono">marketplace/</span> seed; in
              production set <span className="font-mono">EDEN_CATALOG_REPO</span> to an
              &ldquo;owner/repo&rdquo; pointer at the catalog.
            </CardDescription>
            <p className="mt-3 max-w-lg font-mono text-xs text-muted-foreground">
              {catalogError}
            </p>
          </CardHeader>
        </Card>
      ) : (
        <>
          <div className="mb-6 flex flex-wrap items-center gap-1 text-sm">
            <FilterTab
              label="All"
              count={templates.length}
              active={filter === "all"}
              onClick={() => setFilter("all")}
            />
            {DISPLAY_ORDER.map((t) => (
              <FilterTab
                key={t}
                label={TYPE_META[t].plural}
                dot={TYPE_META[t].dot}
                count={counts[t]}
                active={filter === t}
                onClick={() => setFilter(t)}
              />
            ))}
          </div>

          {shown.length === 0 ? (
            <Card className="border-dashed">
              <CardHeader className="items-center py-12 text-center">
                <CardTitle className="text-lg">Nothing here yet</CardTitle>
                <CardDescription>
                  No templates in this category. Check back as the catalog grows.
                </CardDescription>
              </CardHeader>
            </Card>
          ) : filter === "all" ? (
            // "All" groups by type so the catalog reads as sections, not one undifferentiated
            // wall of cards. A single filtered type stays a flat grid (the header'd be noise).
            <div className="space-y-8">
              {DISPLAY_ORDER.filter((t) => counts[t] > 0).map((t) => {
                const meta = TYPE_META[t];
                const Icon = meta.icon;
                return (
                  <section key={t}>
                    <div className="mb-3 flex items-center gap-2">
                      <span
                        className={`flex size-6 items-center justify-center rounded-md ${meta.accent}`}
                      >
                        <Icon className="size-3.5" />
                      </span>
                      <h2 className="text-sm font-medium">{meta.plural}</h2>
                      <span className="text-xs text-muted-foreground">{counts[t]}</span>
                    </div>
                    <div className="grid gap-4 sm:grid-cols-2">
                      {templates
                        .filter((tpl) => tpl.type === t)
                        .map((tpl) => (
                          <TemplateCard key={`${tpl.type}/${tpl.id}`} tpl={tpl} />
                        ))}
                    </div>
                  </section>
                );
              })}
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {shown.map((tpl) => (
                <TemplateCard key={`${tpl.type}/${tpl.id}`} tpl={tpl} />
              ))}
            </div>
          )}
        </>
      )}
    </AppShell>
  );
}

function FilterTab({
  label,
  count,
  active,
  onClick,
  dot,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  /** Type accent swatch; omitted for the "All" tab. */
  dot?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-muted-foreground transition-colors hover:text-foreground " +
        (active ? "bg-accent font-medium text-foreground" : "")
      }
    >
      {dot && <span className={`size-1.5 rounded-full ${dot}`} />}
      {label}
      <span className="text-xs text-muted-foreground">{count}</span>
    </button>
  );
}

/** A coloured icon + label chip marking a template's type. */
function TypeBadge({ type }: { type: TemplateType }) {
  const meta = TYPE_META[type];
  const Icon = meta.icon;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ${meta.accent}`}
    >
      <Icon className="size-3" />
      {meta.label}
    </span>
  );
}

/** One catalog entry as a card, linking to its detail page. */
function TemplateCard({ tpl }: { tpl: Route.ComponentProps["loaderData"]["templates"][number] }) {
  return (
    <Link
      to={`/marketplace/${tpl.type}/${tpl.id}`}
      prefetch="intent"
      className="group"
    >
      <Card className="h-full transition-colors group-hover:border-ring/60">
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="truncate text-base">{tpl.name}</CardTitle>
            <TypeBadge type={tpl.type} />
          </div>
          <CardDescription className="line-clamp-2">{tpl.description}</CardDescription>
          <p className="mt-1 font-mono text-xs text-muted-foreground">v{tpl.version}</p>
        </CardHeader>
      </Card>
    </Link>
  );
}
