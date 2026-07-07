/**
 * Quick deploy — the "ship it" button in the tab row (AgentNav), at every hierarchy level and on
 * every tab, so a PM never has to navigate to a specific page to ship (PRD §7.3/§7.7).
 *
 * Its ONE job is the staged-changes short-circuit: publish the project's staged drafts → merge →
 * cut a version → deploy the WHOLE team into one environment. It never ships the branch head and
 * never redeploys a subset of the roster, so it renders nothing when nothing is staged. The click
 * ALWAYS opens a confirmation dialog (no instant deploy, no env-dropdown-as-button) — a ship is
 * irreversible enough to warrant a look at what it will do first. The current version keeps
 * serving until the new one is healthy, so shipping is never a step backwards.
 *
 * Like StagedChangesPill this self-fetches from a resource route (repos/<id>/quick-deploy) so it
 * lives in the shared nav without every page's loader threading ship data through; React Router
 * revalidates the fetcher after actions, keeping the breakdown honest as drafts stage and publish.
 * A SEPARATE POST fetcher runs the ship, so its "Deploying…" state is independent of the data
 * fetch. On success the POST action redirects to the scope's Overview, where the ShipProgress
 * banner takes over (and this dialog unmounts); on error it returns { error }, which we show inside
 * the dialog and keep the dialog OPEN so the user can retry or cancel.
 *
 * The dialog is transparent about scope: a file breakdown grouped by owning member (+ a "shared —
 * affects everyone" block), the "Will deploy" roster (the whole team redeploys together so no
 * member is left on an older version), and a team-level environment picker.
 */
import { Rocket } from "lucide-react";
import { useEffect, useState } from "react";
import { useFetcher } from "react-router";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";

// Local mirror of the resource route's GET payload (kept in sync with api.quick-deploy.tsx).
interface QuickDeployData {
  draftCount: number;
  groups: { member: string | null; files: string[] }[];
  members: string[];
  envNames: string[];
}

export function QuickDeploy({ base }: { base: string }) {
  // Same regex + resource-route derivation as StagedChangesPill: parse projectId + optional member
  // out of the nav base. The data fetch is scope-independent (the button always ships all project
  // drafts); the member only decides which Overview the POST redirect returns to.
  const match = base.match(/^\/repos\/([^/]+)(?:\/agents\/([^/]+))?$/);
  const projectId = match?.[1] ?? null;
  const agent = match?.[2] ?? null;
  const url = projectId ? `/repos/${projectId}/quick-deploy` : null;

  const data = useFetcher<QuickDeployData>();
  const { load } = data;
  useEffect(() => {
    if (url) load(url);
  }, [url, load]);

  const payload = data.data;
  // Render nothing until data arrives, or when there is nothing staged (no repo, read error, or
  // genuinely none) — a hidden button beats a broken one in the shared nav.
  if (!url || !payload || payload.draftCount === 0) return null;

  return <QuickDeployDialog action={url} agent={agent} data={payload} />;
}

function QuickDeployDialog({
  action,
  agent,
  data,
}: {
  action: string;
  agent: string | null;
  data: QuickDeployData;
}) {
  const [open, setOpen] = useState(false);
  const ship = useFetcher<{ error?: string }>();
  const deploying = ship.state !== "idle";
  const error = ship.data?.error;

  // Target environments: the team's env names (primary-first). One env → static text; more than
  // one → a Select. Preselect the first, and re-pin if the option set shifts.
  const envOptions = data.envNames;
  const [env, setEnv] = useState(envOptions[0] ?? "");
  useEffect(() => {
    if (envOptions.length > 0 && !envOptions.includes(env)) setEnv(envOptions[0]);
  }, [envOptions, env]);

  const count = data.draftCount;

  const submit = () => {
    ship.submit(agent ? { env, agent } : { env }, { method: "post", action });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Rocket className="h-4 w-4" aria-hidden />
          Quick deploy
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            Deploy {count} staged change{count === 1 ? "" : "s"}?
          </DialogTitle>
          <DialogDescription>
            Publishes the changes as a change request, merges it, cuts a new version, and deploys
            the whole team. The current version keeps serving until the new one is healthy.
          </DialogDescription>
        </DialogHeader>

        {/* File breakdown: one block per owning member, a "shared" block last if present. */}
        {/* min-w-0 everywhere: DialogContent is a grid, and grid items default to min-width auto,
            so an unbroken mono path would otherwise push the dialog wider than its max. */}
        <div className="min-w-0 space-y-3">
          {data.groups.map((group) => {
            const shared = group.member === null;
            return (
              <div key={group.member ?? "__shared__"} className="min-w-0 text-xs">
                <div className="flex items-center gap-2">
                  <span
                    className="size-1.5 shrink-0 rounded-full bg-amber-500"
                    aria-hidden
                  />
                  {shared ? (
                    <span className="font-medium">Shared — affects all members</span>
                  ) : (
                    <span className="font-mono font-medium">{group.member}</span>
                  )}
                </div>
                <ul className="mt-1 min-w-0 space-y-0.5">
                  {group.files.map((file) => (
                    <li key={file} className="break-all font-mono text-muted-foreground">
                      {file}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>

        {/* The whole team always redeploys together — no member is left on an older version. */}
        <div className="min-w-0 break-words text-xs">
          <p>
            <span className="font-medium">Will deploy:</span>{" "}
            <span className="font-mono">{data.members.join(", ")}</span>
          </p>
          <p className="mt-1 text-muted-foreground">
            The whole team redeploys together so no member is left on an older version.
          </p>
        </div>

        {/* Environment target: Select when the team has >1 env name, else static. */}
        <div className="space-y-1.5">
          <span className="text-xs font-medium">Environment</span>
          {envOptions.length > 1 ? (
            <Select value={env} onValueChange={setEnv}>
              <SelectTrigger className="h-8 font-mono text-xs" aria-label="Deploy environment">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {envOptions.map((name) => (
                  <SelectItem key={name} value={name} className="font-mono text-xs">
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <p className="text-xs text-muted-foreground">
              Deploying to <span className="font-mono">{env || "—"}</span>
            </p>
          )}
        </div>

        {/* A ship that errors (build gate, missing env) returns { error } instead of redirecting —
            surface it here with room to read it, and keep the dialog open to retry or cancel. */}
        {error && (
          <p className="min-w-0 break-words text-xs text-destructive">{error}</p>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={deploying}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={deploying || !env}>
            <Rocket className="h-4 w-4" aria-hidden />
            {deploying ? "Deploying…" : `Deploy to ${env || "…"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
