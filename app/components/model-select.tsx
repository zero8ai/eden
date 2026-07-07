/**
 * Searchable model picker over the live OpenRouter catalog (replaces the old shortlist
 * dropdown + free-text field).
 *
 * Agent model ids are OpenRouter ids and are written into `openrouter.chatModel("...")` wiring
 * by the settings route. The catalog is fetched lazily (`/api/models`, on first open) so the
 * settings page pays nothing until the picker opens, and the whole thing degrades gracefully:
 * if OpenRouter is unreachable the picker becomes a plain free-text field, so model editing
 * is never blocked. Committing a value calls onCommit — the caller stages the agent.ts draft
 * like every other edit.
 */
import { Check, TriangleAlert } from "lucide-react";
import * as React from "react";
import { useMemo, useState } from "react";
import { useFetcher } from "react-router";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/ui/popover";
import { SUGGESTED_MODELS } from "~/eve/agentModule";
import { filterModels } from "~/models/filter";
import type { ModelCatalogEntry } from "~/models/catalog.server";
import { cn } from "~/lib/utils";

/** Show at most this many rows — the catalog is ~300 models; a plain list stays snappy. */
const MAX_ROWS = 50;

/** "1.0M ctx" / "256K ctx" — compact context-window label, or null when unknown. */
function formatContext(tokens: number | null): string | null {
  if (tokens == null) return null;
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M ctx`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K ctx`;
  return `${tokens} ctx`;
}

/** "$1.40 / $4.40 per M" (input/output USD per 1M tokens), or null when priceless. */
function formatPricing(model: ModelCatalogEntry): string | null {
  if (model.inputPerMTok == null || model.outputPerMTok == null) return null;
  return `$${model.inputPerMTok.toFixed(2)} / $${model.outputPerMTok.toFixed(2)} per M`;
}

export function ModelSelect({
  value,
  busy,
  onCommit,
}: {
  /** Current model id (repo or staged draft), or null when agent.ts has none yet. */
  value: string | null;
  /** Disable while the stage request is in flight. */
  busy: boolean;
  onCommit: (model: string) => void;
}) {
  const fetcher = useFetcher<{ models: ModelCatalogEntry[] | null }>();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);

  // undefined = not loaded yet, null = fetch failed, array = catalog.
  const models = fetcher.data?.models;
  const failed = models === null;
  const loading = fetcher.state === "loading";

  const commit = (id: string) => {
    const trimmed = id.trim();
    if (!trimmed) return;
    setOpen(false);
    setQuery("");
    onCommit(trimmed);
  };

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      setQuery("");
      setHighlight(0);
      // Lazy-load the catalog on first open; refetch only if a prior load errored.
      if (fetcher.state === "idle" && (!fetcher.data || failed)) {
        fetcher.load("/api/models");
      }
    }
  };

  // Build the display rows (with group labels) and a parallel list of commit targets that the
  // flat highlight index maps into. Groups: "Popular" (suggested ∩ catalog) then "All" when the
  // search is empty; a single filtered list otherwise. A final "custom id" row appears when the
  // query doesn't exactly match a catalog id (the escape hatch for ids the catalog doesn't know).
  const { display, targets } = useMemo(() => {
    type Row =
      | { type: "label"; text: string }
      | { type: "model"; model: ModelCatalogEntry; index: number }
      | { type: "custom"; id: string; index: number };

    const rows: Row[] = [];
    const commitTargets: string[] = [];
    if (!models) return { display: rows, targets: commitTargets };

    const q = query.trim();
    const pushModels = (list: ModelCatalogEntry[]) => {
      for (const m of list) {
        rows.push({ type: "model", model: m, index: commitTargets.length });
        commitTargets.push(m.id);
      }
    };

    if (!q) {
      const popular = SUGGESTED_MODELS.map((id) =>
        models.find((m) => m.id === id),
      ).filter((m): m is ModelCatalogEntry => Boolean(m));
      if (popular.length > 0) {
        rows.push({ type: "label", text: "Popular" });
        pushModels(popular);
      }
      rows.push({ type: "label", text: "All models" });
      pushModels(models.slice(0, MAX_ROWS));
      if (models.length > MAX_ROWS) {
        rows.push({
          type: "label",
          text: `…${models.length - MAX_ROWS} more — type to search`,
        });
      }
    } else {
      pushModels(filterModels(models, q).slice(0, MAX_ROWS));
      const exact = models.some((m) => m.id === q);
      if (!exact) {
        rows.push({ type: "custom", id: q, index: commitTargets.length });
        commitTargets.push(q);
      }
    }
    return { display: rows, targets: commitTargets };
  }, [models, query]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(targets.length - 1, h + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const target = targets[highlight];
      if (target) commit(target);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  // Fetch failed: degrade to a free-text field so model editing is never blocked.
  if (failed) {
    return <FreeTextFallback value={value} busy={busy} onCommit={onCommit} />;
  }

  const offCatalog =
    Boolean(value) && Array.isArray(models) && !models.some((m) => m.id === value);

  return (
    <div>
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            disabled={busy}
            aria-label="Model"
            className="w-full justify-between font-mono text-sm sm:w-72"
          >
            <span className="truncate">
              {busy ? "Saving…" : (value ?? "Pick a model")}
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[calc(100vw-2rem)] p-0 sm:w-96">
          <div className="border-b border-border p-1">
            <Input
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setHighlight(0);
              }}
              onKeyDown={onKeyDown}
              placeholder="Search models…"
              className="border-0 font-mono text-sm focus-visible:ring-0"
              aria-label="Search models"
            />
          </div>
          <div
            role="listbox"
            aria-label="Models"
            className="max-h-80 overflow-y-auto p-1"
          >
            {loading && !models && (
              <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                Loading models…
              </p>
            )}
            {models && display.length === 0 && (
              <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                No models match “{query.trim()}”.
              </p>
            )}
            {display.map((row, i) => {
              if (row.type === "label") {
                return (
                  <div
                    key={`label-${row.text}-${i}`}
                    className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground"
                  >
                    {row.text}
                  </div>
                );
              }
              if (row.type === "custom") {
                return (
                  <Option
                    key="custom"
                    highlighted={highlight === row.index}
                    onHighlight={() => setHighlight(row.index)}
                    onSelect={() => commit(row.id)}
                  >
                    <span className="text-sm">
                      Use{" "}
                      <span className="font-mono">“{row.id}”</span> as a custom id
                    </span>
                  </Option>
                );
              }
              const { model } = row;
              const ctx = formatContext(model.contextWindow);
              const price = formatPricing(model);
              return (
                <Option
                  key={model.id}
                  highlighted={highlight === row.index}
                  onHighlight={() => setHighlight(row.index)}
                  onSelect={() => commit(model.id)}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">{model.name}</div>
                    <div className="truncate font-mono text-xs text-muted-foreground">
                      {model.id}
                    </div>
                  </div>
                  <div className="shrink-0 text-right text-xs text-muted-foreground">
                    {ctx && <div>{ctx}</div>}
                    {price && <div>{price}</div>}
                  </div>
                  {model.id === value && (
                    <Check
                      className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
                      aria-hidden
                    />
                  )}
                </Option>
              );
            })}
          </div>
        </PopoverContent>
      </Popover>
      {offCatalog && (
        <p className="mt-2 flex max-w-md items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            <span className="font-mono">{value}</span> is not in the OpenRouter
            catalog. It will be saved as a custom model id.
          </span>
        </p>
      )}
    </div>
  );
}

/** One selectable row in the listbox. */
function Option({
  highlighted,
  onHighlight,
  onSelect,
  children,
}: {
  highlighted: boolean;
  onHighlight: () => void;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      role="option"
      aria-selected={highlighted}
      tabIndex={highlighted ? 0 : -1}
      onMouseMove={onHighlight}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5",
        highlighted && "bg-accent text-accent-foreground",
      )}
    >
      {children}
    </div>
  );
}

/** Free-text fallback shown when the catalog can't be loaded — never block editing. */
function FreeTextFallback({
  value,
  busy,
  onCommit,
}: {
  value: string | null;
  busy: boolean;
  onCommit: (model: string) => void;
}) {
  const [text, setText] = useState(value ?? "");
  const submit = () => {
    const id = text.trim();
    if (id) onCommit(id);
  };
  return (
    <div className="flex items-center gap-2">
      <Input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
        placeholder="provider/model-id"
        className="w-full font-mono text-sm sm:w-72"
        aria-label="Model id"
        disabled={busy}
      />
      <Button
        size="sm"
        variant="secondary"
        onClick={submit}
        disabled={busy || !text.trim()}
      >
        {busy ? "Saving…" : "Set"}
      </Button>
    </div>
  );
}
