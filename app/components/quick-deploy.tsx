/**
 * Quick deploy — the always-visible "ship it" button in the tab row (AgentNav), at every
 * hierarchy level and on every tab, so a PM never has to navigate to Overview/Deployment to
 * ship (PRD §7.3/§7.7). Clicking it runs the WHOLE Ship pipeline: publish staged drafts →
 * merge → cut a version → deploy, or ship the branch head when nothing is staged. The current
 * version keeps serving until the new one is healthy, so shipping is never a step backwards.
 *
 * Like StagedChangesPill this self-fetches from a resource route (repos/<id>/quick-deploy) so it
 * lives in the shared nav without every page's loader threading ship data through; React Router
 * revalidates the fetcher after actions, keeping the label honest as drafts stage and publish.
 * The GET fetcher supplies the button's data; a SEPARATE POST fetcher runs the ship, so its
 * loading state is independent of the count fetch. The POST action redirects the browser to the
 * scope's Overview, where the existing ShipProgress banner takes over — that's the end state.
 *
 * Environments are per-agent and user-defined (M5.7): a scope with exactly one env deploys with
 * no dialog; more than one turns the button into a dropdown of "Deploy to <env>". The server
 * re-decides staged-vs-head at POST time, so the client's draftCount only informs the hover
 * hint — a stale count can never ship the wrong thing.
 */
import { ChevronDown, Rocket } from "lucide-react";
import { useEffect } from "react";
import { useFetcher } from "react-router";

import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";

interface QuickDeployData {
  envNames: string[];
  draftCount: number;
  defaultBranch: string;
}

/** Hover hint: says exactly what THIS click will do — staged publish or branch-head ship. */
function hint(draftCount: number, defaultBranch: string): string {
  return draftCount > 0
    ? `Publish ${draftCount} staged change${draftCount === 1 ? "" : "s"}, cut a version, and deploy`
    : `Ship the latest from ${defaultBranch}: cut a version and deploy (an already-shipped commit is reused)`;
}

export function QuickDeploy({ base }: { base: string }) {
  // Same regex + resource-route derivation as StagedChangesPill: parse projectId + optional
  // member out of the nav base so the button self-fetches its own scope.
  const match = base.match(/^\/repos\/([^/]+)(?:\/agents\/([^/]+))?$/);
  const projectId = match?.[1] ?? null;
  const agent = match?.[2] ?? null;
  const loadUrl = projectId
    ? `/repos/${projectId}/quick-deploy${agent ? `?agent=${agent}` : ""}`
    : null;
  const postAction = projectId ? `/repos/${projectId}/quick-deploy` : null;

  const data = useFetcher<QuickDeployData>();
  const { load } = data;
  useEffect(() => {
    if (loadUrl) load(loadUrl);
  }, [loadUrl, load]);

  // Independent POST fetcher: shipping shouldn't be entangled with the count reload, and its
  // `state` drives the button's "Deploying…" label without touching the GET fetcher.
  const ship = useFetcher<{ error?: string }>();
  const deploying = ship.state !== "idle";

  const envNames = data.data?.envNames ?? [];
  // Render nothing until data arrives, or when the scope has no environment to ship to (no repo,
  // read error, or genuinely none) — a hidden button beats a broken one in the shared nav.
  if (!postAction || envNames.length === 0) return null;

  const submit = (env: string) => {
    ship.submit(
      agent ? { env, agent } : { env },
      { method: "post", action: postAction },
    );
  };

  const label = deploying ? "Deploying…" : "Quick deploy";
  const title = hint(data.data?.draftCount ?? 0, data.data?.defaultBranch ?? "main");
  const error = ship.data?.error;

  return (
    <div className="flex items-center gap-2">
      {envNames.length === 1 ? (
        <Button
          size="sm"
          disabled={deploying}
          onClick={() => submit(envNames[0])}
          title={title}
          aria-label={title}
        >
          <Rocket className="h-4 w-4" aria-hidden />
          {label}
        </Button>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" disabled={deploying} title={title} aria-label={title}>
              <Rocket className="h-4 w-4" aria-hidden />
              {label}
              <ChevronDown className="h-4 w-4" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {envNames.map((env) => (
              <DropdownMenuItem
                key={env}
                onClick={() => submit(env)}
                className="cursor-pointer"
              >
                Deploy to {env}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {/* A ship that errors (build gate, missing env) returns { error } instead of redirecting —
          surface it compactly next to the button, full text on hover. */}
      {error && (
        <span
          className="max-w-40 truncate text-xs text-destructive"
          title={error}
        >
          {error}
        </span>
      )}
    </div>
  );
}
