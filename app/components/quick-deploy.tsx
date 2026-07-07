/**
 * Quick deploy — the "ship it" button in the tab row (AgentNav), at every hierarchy level and on
 * every tab, so a PM never has to navigate to a specific page to ship (PRD §7.3/§7.7).
 *
 * Its ONE job is the staged-changes short-circuit: publish the project's staged drafts → merge →
 * cut a version → deploy the AFFECTED members. It never ships the branch head and never redeploys
 * the whole roster to "latest", so it renders nothing when nothing is staged. The click ALWAYS
 * opens a confirmation dialog (no instant deploy, no env-dropdown-as-button) — a ship is
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
 * The dialog is fully transparent about scope: a file breakdown grouped by owning member (+ a
 * "shared — affects everyone" block), the expanded "Will deploy" roster, and — for the selected
 * environment — an inline warning on any affected member that has no environment by that name, so
 * a skip is known BEFORE confirming rather than only in the after-banner.
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
import { unionEnvNames } from "~/deploy/quick-deploy";

// Local mirror of the resource route's GET payload (kept in sync with api.quick-deploy.tsx).
interface QuickDeployData {
  draftCount: number;
  groups: { member: string | null; files: string[] }[];
  affected: { name: string; envNames: string[] }[];
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

  // Target environments: the union over AFFECTED members only (primary-first). One env → static
  // text; more than one → a Select. Preselect the first, and re-pin if the option set shifts.
  const envOptions = unionEnvNames(data.affected.map((a) => a.envNames));
  const [env, setEnv] = useState(envOptions[0] ?? "");
  useEffect(() => {
    if (envOptions.length > 0 && !envOptions.includes(env)) setEnv(envOptions[0]);
  }, [envOptions, env]);

  const count = data.draftCount;
  const affectedNames = data.affected.map((a) => a.name);
  // Members that will be skipped for the CURRENT target — known before confirming, not just after.
  const ownerNames = new Set(
    data.groups.filter((g) => g.member !== null).map((g) => g.member),
  );
  const mismatch = (name: string) =>
    !(data.affected.find((a) => a.name === name)?.envNames ?? []).includes(env);
  const extraSkipped = data.affected
    .map((a) => a.name)
    .filter((name) => mismatch(name) && !ownerNames.has(name));

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
            every affected member. The current version keeps serving until the new one is healthy.
          </DialogDescription>
        </DialogHeader>

        {/* File breakdown: one block per owning member, a "shared" block last if present. */}
        {/* min-w-0 everywhere: DialogContent is a grid, and grid items default to min-width auto,
            so an unbroken mono path would otherwise push the dialog wider than its max. */}
        <div className="min-w-0 space-y-3">
          {data.groups.map((group) => {
            const shared = group.member === null;
            const skipped = !shared && mismatch(group.member!);
            return (
              <div key={group.member ?? "__shared__"} className="min-w-0 text-xs">
                <div className="flex items-baseline gap-2">
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
                {shared && (
                  <p className="mt-1 text-muted-foreground">
                    Every member will be rebuilt and redeployed because of the shared change.
                  </p>
                )}
                {skipped && (
                  <p className="mt-1 text-destructive">
                    won&apos;t deploy — no environment named {env}
                  </p>
                )}
              </div>
            );
          })}
        </div>

        {/* Expanded deploy set — shared drafts fan out to the whole roster. */}
        <p className="min-w-0 break-words text-xs">
          <span className="font-medium">Will deploy:</span>{" "}
          <span className="font-mono">{affectedNames.join(", ")}</span>
        </p>
        {/* Any affected member without the target env that has NO breakdown block of its own
            (i.e. pulled in by a shared change) — warn here so no skip is a surprise. */}
        {extraSkipped.map((name) => (
          <p key={name} className="text-xs text-destructive">
            <span className="font-mono">{name}</span> won&apos;t deploy — no environment named {env}
          </p>
        ))}

        {/* Environment target: Select when affected members expose >1 distinct name, else static. */}
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
            {deploying ? "Deploying…" : `Deploy to ${env || "…"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
