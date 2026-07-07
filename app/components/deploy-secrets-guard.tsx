/**
 * Deploy guard (PLAN-SECRETS-REWORK §9): a blocking-but-overridable dialog shown at deploy
 * initiation when the member still has template-required secrets unset. Each missing row is
 * fixable INLINE — a value input [Set], or [Attach] when a project-level shared secret with
 * that name exists — via fetchers against the settings action (the same intents Settings uses).
 * `Deploy` enables only when every row is resolved; `Deploy anyway` never blocks; dismissed
 * requirements never trigger the guard (excluded upstream in computeRequiredSecrets).
 */
import { Check, TriangleAlert } from "lucide-react";
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
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { COPY } from "~/components/secrets-card";

export interface GuardMissingSecret {
  name: string;
  description?: string;
  sandbox?: boolean;
  sources: string[];
  sharedExists: boolean;
  /** Team deploys aggregate across members — the owning member, shown as a prefix. */
  member?: string;
}

function GuardRow({
  secret,
  activeAgent,
  settingsAction,
  onResolved,
}: {
  secret: GuardMissingSecret;
  activeAgent: string;
  settingsAction: string;
  onResolved: (name: string) => void;
}) {
  const setFetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const attachFetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const [value, setValue] = useState("");
  const busy = setFetcher.state !== "idle" || attachFetcher.state !== "idle";
  const resolved =
    (setFetcher.state === "idle" && setFetcher.data?.ok) ||
    (attachFetcher.state === "idle" && attachFetcher.data?.ok);

  useEffect(() => {
    if (resolved) onResolved(secret.name);
  }, [resolved, onResolved, secret.name]);

  if (resolved) {
    return (
      <li className="flex items-center gap-2 rounded-md border border-emerald-500/40 px-3 py-2 text-sm">
        <Check className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
        <span className="font-mono">{secret.name}</span>
        <span className="text-xs text-emerald-600 dark:text-emerald-400">resolved</span>
      </li>
    );
  }

  return (
    <li className="space-y-1.5 rounded-md border border-amber-500/50 px-3 py-2">
      <div className="flex items-center gap-2 text-sm">
        <TriangleAlert
          className="size-4 shrink-0 text-amber-600 dark:text-amber-400"
          aria-hidden
        />
        {secret.member && (
          <span className="font-mono text-xs text-muted-foreground">{secret.member}:</span>
        )}
        <span className="font-mono">{secret.name}</span>
        <span className="ml-auto text-xs text-muted-foreground">
          required · {secret.sources[0]}
          {secret.sources.length > 1 && ` +${secret.sources.length - 1}`}
        </span>
      </div>
      {secret.description && (
        <p className="text-xs text-muted-foreground">&ldquo;{secret.description}&rdquo;</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="value (write-only)"
          autoComplete="off"
          className="w-full sm:w-56 font-mono"
        />
        <Button
          type="button"
          size="sm"
          disabled={busy || !value}
          onClick={() => {
            setFetcher.submit(
              {
                intent: "secret-set",
                agent: activeAgent,
                env: "all",
                key: secret.name,
                value,
                exposed: (secret.sandbox ?? false) ? "1" : "0",
              },
              { method: "post", action: settingsAction },
            );
            setValue("");
          }}
        >
          Set
        </Button>
        {secret.sharedExists && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() =>
              attachFetcher.submit(
                {
                  intent: "secret-attach",
                  agent: activeAgent,
                  key: secret.name,
                  exposed: (secret.sandbox ?? false) ? "1" : "0",
                },
                { method: "post", action: settingsAction },
              )
            }
          >
            Attach
          </Button>
        )}
      </div>
      {(setFetcher.data?.error || attachFetcher.data?.error) && (
        <p className="text-xs text-destructive">
          {setFetcher.data?.error ?? attachFetcher.data?.error}
        </p>
      )}
    </li>
  );
}

export function DeploySecretsGuardDialog({
  open,
  onOpenChange,
  missing,
  activeAgent,
  settingsAction,
  deployLabel,
  onDeploy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  missing: GuardMissingSecret[];
  activeAgent: string;
  settingsAction: string;
  deployLabel: string;
  onDeploy: () => void;
}) {
  const [resolvedNames, setResolvedNames] = useState<Set<string>>(new Set());
  const allResolved = missing.every((m) => resolvedNames.has(m.name));

  const markResolved = (name: string) =>
    setResolvedNames((prev) => {
      if (prev.has(name)) return prev;
      const next = new Set(prev);
      next.add(name);
      return next;
    });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{COPY.deployDialogTitle}</DialogTitle>
          <DialogDescription>
            {activeAgent}&rsquo;s templates require{" "}
            {missing.length === 1 ? "a secret that isn't" : `${missing.length} secrets that aren't`}{" "}
            set. Fix them here, or deploy anyway — the agent will run without them.
          </DialogDescription>
        </DialogHeader>
        <ul className="space-y-2">
          {missing.map((m) => (
            <GuardRow
              key={m.name}
              secret={m}
              activeAgent={activeAgent}
              settingsAction={settingsAction}
              onResolved={markResolved}
            />
          ))}
        </ul>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              onOpenChange(false);
              onDeploy();
            }}
          >
            {deployLabel} anyway
          </Button>
          <Button
            disabled={!allResolved}
            onClick={() => {
              onOpenChange(false);
              onDeploy();
            }}
          >
            {deployLabel} ✓
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
