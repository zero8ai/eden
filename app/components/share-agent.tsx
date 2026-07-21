/**
 * Share an agent (issue #180) — the one-click access control that replaces hand-managing a
 * "portal". A button in the agent nav opens this dialog: invite someone by email (they get a
 * magic-link sign-in), see who has access, and revoke. The portal is auto-provisioned on the
 * first invite; deeper controls (model, rate limits) live on the Portals admin page.
 */
import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { Share2, X } from "lucide-react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";

interface ShareData {
  agentName: string;
  portalSlug: string | null;
  people: { id: string; email: string }[];
}

type MutationResult =
  | { ok: true; warning?: string }
  | { error: string }
  | undefined;

export function ShareAgent({ base }: { base: string }) {
  const match = base.match(/^\/repos\/([^/]+)(?:\/agents\/([^/]+))?$/);
  const projectId = match?.[1] ?? null;
  const agentName = match?.[2] ?? null;
  if (!projectId) return null;

  return (
    <ShareAgentControl projectId={projectId} agentName={agentName} />
  );
}

function ShareAgentControl({
  projectId,
  agentName,
}: {
  projectId: string;
  agentName: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);

  const query = agentName ? `?agentName=${encodeURIComponent(agentName)}` : "";
  const endpoint = `/api/repos/${projectId}/share`;

  const list = useFetcher<ShareData>();
  const mutate = useFetcher<MutationResult>();
  const { load } = list;

  // Load the access list when the dialog opens.
  useEffect(() => {
    if (open) load(`${endpoint}${query}`);
  }, [open, load, endpoint, query]);

  // After a successful mutation, refresh the list and reset the invite form.
  const mutateData = mutate.data;
  useEffect(() => {
    if (mutate.state === "idle" && mutateData && "ok" in mutateData) {
      load(`${endpoint}${query}`);
      if (emailRef.current) emailRef.current.value = "";
    }
  }, [mutate.state, mutateData, load, endpoint, query]);

  const inviteError =
    mutateData && "error" in mutateData ? mutateData.error : null;
  const inviteWarning =
    mutateData && "ok" in mutateData ? mutateData.warning : null;
  const people = list.data?.people ?? [];
  const busy = mutate.state !== "idle";

  function submitInvite(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    if (!email) return;
    setSentTo(email);
    mutate.submit(
      { intent: "invite", email, ...(agentName ? { agentName } : {}) },
      { method: "post", action: endpoint },
    );
  }

  function revoke(grantId: string) {
    setSentTo(null);
    mutate.submit(
      { intent: "revoke", grantId, ...(agentName ? { agentName } : {}) },
      { method: "post", action: endpoint },
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Share2 className="size-4" />
          Share
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Share this agent</DialogTitle>
          <DialogDescription>
            Invite people by email. They get a one-click sign-in link and can
            chat with the agent in their browser — no account needed.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submitInvite} className="flex items-end gap-2">
          <div className="flex-1 space-y-2">
            <Label htmlFor="share-email">Email</Label>
            <Input
              ref={emailRef}
              id="share-email"
              name="email"
              type="email"
              autoComplete="off"
              placeholder="person@company.com"
              required
            />
          </div>
          <Button type="submit" disabled={busy}>
            {busy ? "Sending…" : "Send invite"}
          </Button>
        </form>
        {inviteError && (
          <p role="alert" className="text-sm text-destructive">
            {inviteError}
          </p>
        )}
        {!inviteError && inviteWarning && (
          <p role="alert" className="text-sm text-amber-600 dark:text-amber-500">
            {inviteWarning}
          </p>
        )}
        {!inviteError && !inviteWarning && sentTo && !busy && (
          <p className="text-sm text-muted-foreground">
            Invite sent to <span className="font-medium">{sentTo}</span>.
          </p>
        )}

        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">
            People with access
          </p>
          {people.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">
              No one yet. Invite someone above to get started.
            </p>
          ) : (
            <ul className="divide-y rounded-md border">
              {people.map((person) => (
                <li
                  key={person.id}
                  className="flex items-center justify-between gap-3 px-3 py-2"
                >
                  <span className="truncate text-sm" title={person.email}>
                    {person.email}
                  </span>
                  <button
                    type="button"
                    onClick={() => revoke(person.id)}
                    disabled={busy}
                    className="shrink-0 text-muted-foreground transition-colors hover:text-destructive disabled:opacity-50"
                    aria-label={`Remove ${person.email}`}
                    title="Remove access"
                  >
                    <X className="size-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
