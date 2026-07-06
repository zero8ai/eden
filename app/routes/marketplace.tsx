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
import { useState } from "react";
import { Link, type LoaderFunctionArgs } from "react-router";

import { AppShell, PageHeader } from "~/components/shell";
import { Badge } from "~/components/ui/badge";
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

/** Human plural label for a template type, for the filter tabs. */
const TYPE_LABELS: Record<TemplateType, string> = {
  agent: "Agents",
  tool: "Tools",
  skill: "Skills",
  subagent: "Subagents",
  channel: "Channels",
  connection: "Connections",
};

/** Badge label for a single template's type. */
const TYPE_BADGE: Record<TemplateType, string> = {
  agent: "Agent",
  tool: "Tool",
  skill: "Skill",
  subagent: "Subagent",
  channel: "Channel",
  connection: "Connection",
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
  return [{ title: "Marketplace · Eden" }];
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
            {TEMPLATE_TYPES.map((t) => (
              <FilterTab
                key={t}
                label={TYPE_LABELS[t]}
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
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {shown.map((tpl) => (
                <Link
                  key={`${tpl.type}/${tpl.id}`}
                  to={`/marketplace/${tpl.type}/${tpl.id}`}
                  prefetch="intent"
                  className="group"
                >
                  <Card className="h-full transition-colors group-hover:border-ring/60">
                    <CardHeader>
                      <div className="flex items-center justify-between gap-2">
                        <CardTitle className="truncate text-base">{tpl.name}</CardTitle>
                        <Badge variant="secondary" className="shrink-0">
                          {TYPE_BADGE[tpl.type]}
                        </Badge>
                      </div>
                      <CardDescription className="line-clamp-2">
                        {tpl.description}
                      </CardDescription>
                      <p className="mt-1 font-mono text-xs text-muted-foreground">
                        v{tpl.version}
                      </p>
                    </CardHeader>
                  </Card>
                </Link>
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
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
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
      {label}
      <span className="text-xs text-muted-foreground">{count}</span>
    </button>
  );
}
