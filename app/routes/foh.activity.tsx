/**
 * FOH activity feed — one team's wall-clock timeline (§5, D14: /t/:projectId/activity).
 * Rendered in place of the agent/session panes: session opens, delegation exchanges
 * ("10:44 sam → ivy: '…'", expandable to the full run transcript via a lazy fetcher on
 * `?exchange=<id>`), runs, and deployments. Cursor-paginated with `?before=<iso>`.
 */
import {
  ChevronDown,
  ChevronRight,
  MessageSquare,
  Rocket,
  Play,
  Zap,
} from "lucide-react";
import { useState } from "react";
import { Link, useFetcher, type LoaderFunctionArgs } from "react-router";

import { sessionLoader } from "~/auth/session.server";
import { LocalizedDateTime } from "~/components/localized-values";
import { Button } from "~/components/ui/button";
import type { ActivityEvent } from "~/foh/activity";
import {
  getDelegationExchange,
  listTeamActivity,
  type DelegationExchange,
} from "~/foh/activity.server";
import { requireFohProject } from "~/foh/guard.server";
import { cn } from "~/lib/utils";
import type { Route } from "./+types/foh.activity";

export const loader = (args: LoaderFunctionArgs) =>
  sessionLoader(
    args,
    async ({ auth }) => {
      const access = await requireFohProject(auth, args.params.projectId, {
        request: args.request,
      });
      const url = new URL(args.request.url);
      const beforeParam = url.searchParams.get("before");
      const before = beforeParam ? new Date(beforeParam) : undefined;
      const exchangeId = url.searchParams.get("exchange");
      const [page, exchange] = await Promise.all([
        listTeamActivity(access.project.id, {
          before: before && !Number.isNaN(before.getTime()) ? before : undefined,
        }),
        exchangeId
          ? getDelegationExchange(access.project.id, exchangeId)
          : Promise.resolve(null),
      ]);
      return {
        projectId: access.project.id,
        projectName: access.project.name,
        events: page.events,
        nextBefore: page.nextBefore,
        paged: before != null,
        exchange,
      };
    },
    { ensureSignedIn: true },
  );

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `activity · ${loaderData?.projectName ?? "eden"}` }];
}

const AGENT_FALLBACK = "removed agent";

function EventTime({ at }: { at: string }) {
  return (
    <span className="w-24 shrink-0 text-xs tabular-nums text-muted-foreground">
      <LocalizedDateTime
        value={at}
        options={{
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        }}
      />
    </span>
  );
}

const DELEGATION_STATUS_LABEL: Record<string, string> = {
  running: "in progress",
  waiting: "waiting on you",
  completed: "completed",
  failed: "failed",
};

function ExchangeView({ exchange }: { exchange: DelegationExchange }) {
  return (
    <div className="mt-2 space-y-2 rounded-md border bg-muted/30 p-3 text-sm">
      {exchange.ask && (
        <p>
          <span className="font-medium">
            {exchange.fromAgentName ?? AGENT_FALLBACK}:
          </span>{" "}
          {exchange.ask}
        </p>
      )}
      {exchange.steps.length === 0 && !exchange.ask ? (
        <p className="text-muted-foreground">
          No transcript was recorded for this exchange.
        </p>
      ) : (
        exchange.steps.map((step, i) =>
          step.kind === "message" ? (
            // The linked run is the PEER's: its "assistant" is the delegate answering.
            <p key={i}>
              <span className="font-medium">
                {step.role === "assistant"
                  ? (exchange.toAgentName ?? AGENT_FALLBACK)
                  : (exchange.fromAgentName ?? AGENT_FALLBACK)}
                :
              </span>{" "}
              {step.text}
            </p>
          ) : step.kind === "tool" ? (
            <p
              key={i}
              className={cn(
                "text-xs text-muted-foreground",
                step.isError && "text-destructive",
              )}
            >
              ⚙ {step.toolName ?? "tool"}
              {step.summary ? ` — ${step.summary}` : ""}
            </p>
          ) : (
            <p key={i} className="text-xs text-destructive">
              {step.text}
            </p>
          ),
        )
      )}
      {exchange.error && (
        <p className="text-xs text-destructive">{exchange.error}</p>
      )}
    </div>
  );
}

function DelegationEntry({
  event,
  projectId,
}: {
  event: Extract<ActivityEvent, { type: "delegation" }>;
  projectId: string;
}) {
  const [open, setOpen] = useState(false);
  const fetcher = useFetcher<typeof loader>();
  const exchange =
    fetcher.data?.exchange?.delegationId === event.delegationId
      ? fetcher.data.exchange
      : null;

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !exchange && fetcher.state === "idle") {
      fetcher.load(
        `/t/${projectId}/activity?exchange=${encodeURIComponent(event.delegationId)}`,
      );
    }
  };

  return (
    <div className="min-w-0 flex-1">
      <p className="text-sm">
        <span className="font-medium">{event.fromAgentName ?? AGENT_FALLBACK}</span>
        {" → "}
        <span className="font-medium">{event.toAgentName ?? AGENT_FALLBACK}</span>
        {event.ask ? <>: “{event.ask}”</> : null}
      </p>
      <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
        <span
          className={cn(
            event.status === "waiting" && "text-amber-600 dark:text-amber-500",
            event.status === "failed" && "text-destructive",
          )}
        >
          {DELEGATION_STATUS_LABEL[event.status] ?? event.status}
        </span>
        <button
          type="button"
          onClick={toggle}
          className="inline-flex items-center gap-0.5 hover:text-foreground"
          aria-expanded={open}
        >
          {open ? (
            <ChevronDown className="size-3" aria-hidden />
          ) : (
            <ChevronRight className="size-3" aria-hidden />
          )}
          {open ? "collapse" : "expand"}
        </button>
      </div>
      {open &&
        (exchange ? (
          <ExchangeView exchange={exchange} />
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">
            {fetcher.state !== "idle"
              ? "Loading exchange…"
              : "No exchange details available."}
          </p>
        ))}
    </div>
  );
}

function EventBody({
  event,
  projectId,
}: {
  event: ActivityEvent;
  projectId: string;
}) {
  switch (event.type) {
    case "delegation":
      return <DelegationEntry event={event} projectId={projectId} />;
    case "session": {
      const opener =
        event.openedByAgentName ?? event.openedByUserName ?? "someone";
      return (
        <div className="min-w-0 flex-1">
          <p className="text-sm">
            <span className="font-medium">{opener}</span> opened a session with{" "}
            <span className="font-medium">{event.agentName ?? AGENT_FALLBACK}</span>
            {event.title ? <>: “{event.title}”</> : null}
          </p>
        </div>
      );
    }
    case "run":
      return (
        <div className="min-w-0 flex-1">
          <p className="text-sm">
            <span className="font-medium">{event.agentName ?? AGENT_FALLBACK}</span>{" "}
            ran{event.channel ? ` via ${event.channel}` : ""}
            {event.input ? <>: “{event.input}”</> : null}
          </p>
          <p
            className={cn(
              "mt-0.5 text-xs text-muted-foreground",
              event.status === "failed" && "text-destructive",
            )}
          >
            {event.status}
            {event.error ? ` — ${event.error}` : ""}
          </p>
        </div>
      );
    case "deployment":
      return (
        <div className="min-w-0 flex-1">
          <p className="text-sm">
            <span className="font-medium">{event.agentName ?? AGENT_FALLBACK}</span>{" "}
            deployment{event.version ? ` of ${event.version}` : ""}
          </p>
          <p
            className={cn(
              "mt-0.5 text-xs text-muted-foreground",
              event.status === "failed" && "text-destructive",
            )}
          >
            {event.status}
          </p>
        </div>
      );
  }
}

const EVENT_ICON = {
  session: MessageSquare,
  delegation: Zap,
  run: Play,
  deployment: Rocket,
} as const;

export default function FohActivity({ loaderData }: Route.ComponentProps) {
  const { projectId, projectName, events, nextBefore, paged } = loaderData;

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <div className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
        <Zap className="size-4 text-muted-foreground" aria-hidden />
        <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">
          Activity — {projectName}
        </h1>
        {paged && (
          <Button asChild variant="ghost" size="sm">
            <Link to={`/t/${projectId}/activity`}>Latest</Link>
          </Button>
        )}
      </div>

      {events.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="max-w-sm px-6 text-center">
            <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Zap className="size-6" aria-hidden />
            </div>
            <h2 className="text-lg font-semibold">Nothing has happened yet</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Sessions, delegations, runs, and deployments for this team will
              show up here as they happen.
            </p>
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ol className="divide-y">
            {events.map((event) => {
              const Icon = EVENT_ICON[event.type];
              return (
                <li key={event.id} className="flex items-start gap-3 px-4 py-3">
                  <EventTime at={event.at} />
                  <Icon
                    className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                  <EventBody event={event} projectId={projectId} />
                </li>
              );
            })}
          </ol>
          {nextBefore && (
            <div className="flex justify-center border-t p-3">
              <Button asChild variant="ghost" size="sm">
                <Link
                  to={`/t/${projectId}/activity?before=${encodeURIComponent(nextBefore)}`}
                >
                  Load older
                </Link>
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
