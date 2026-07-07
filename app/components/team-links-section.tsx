/**
 * Team collaboration matrix (Team delegation — D4). A directed can-ask grid on repo-level
 * Settings for team repos: one row per member ("X can ask:"), a checkbox per OTHER member.
 * Default-allow — a checked box is the absence of an override; unchecking writes a disabled
 * override row. Each checkbox is its own fetcher-JSON toggle (the secrets-card pattern): no
 * navigation, and the change takes effect on the next ask with no redeploy.
 */
import { Users } from "lucide-react";
import { useFetcher } from "react-router";

import { SectionHeader } from "~/components/shell";
import { Card, CardContent } from "~/components/ui/card";

interface Member {
  id: string;
  name: string;
}

interface Link {
  fromAgentId: string;
  toAgentId: string;
  enabled: boolean;
}

/** One directed edge's checkbox — allowed unless a disabled override row exists. */
function LinkCheckbox({
  from,
  to,
  enabled,
}: {
  from: Member;
  to: Member;
  enabled: boolean;
}) {
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
  // Optimistic: reflect the in-flight toggle immediately.
  const checked = fetcher.formData
    ? fetcher.formData.get("enabled") === "1"
    : enabled;
  // A failed toggle reverts optimistically — surface why (the secrets-card intent pattern).
  const error =
    fetcher.state === "idle" && fetcher.data?.error ? fetcher.data.error : null;
  return (
    <div className="flex flex-col items-center gap-0.5">
      <label className="flex items-center justify-center">
        <input
          type="checkbox"
          checked={checked}
          disabled={fetcher.state !== "idle"}
          aria-label={`${from.name} can ask ${to.name}`}
          className="size-4 accent-emerald-600 dark:accent-emerald-500"
          onChange={(e) =>
            fetcher.submit(
              {
                intent: "link-toggle",
                from: from.id,
                to: to.id,
                enabled: e.target.checked ? "1" : "0",
              },
              { method: "post" },
            )
          }
        />
      </label>
      {error && (
        <p className="max-w-32 text-center text-xs text-destructive">
          Couldn&rsquo;t save: {error}
        </p>
      )}
    </div>
  );
}

export function TeamLinksSection({
  members,
  links,
}: {
  members: Member[];
  links: Link[];
}) {
  // Default-allow: a pair is enabled unless a disabled override row says otherwise.
  const disabled = new Set(
    links.filter((l) => !l.enabled).map((l) => `${l.fromAgentId}|${l.toAgentId}`),
  );
  const isEnabled = (fromId: string, toId: string) =>
    !disabled.has(`${fromId}|${toId}`);

  return (
    <section>
      <SectionHeader title="Team collaboration" icon={Users} accent="indigo" />
      <p className="mb-3 text-sm text-muted-foreground">
        By default every member can ask every other member for help. Uncheck a box to stop one
        member from delegating to another. Changes apply immediately — no redeploy.
      </p>
      <Card>
        <CardContent className="overflow-x-auto py-4">
          <table className="w-full min-w-[28rem] border-collapse text-sm">
            <thead>
              <tr>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                  Can ask →
                </th>
                {members.map((m) => (
                  <th
                    key={m.id}
                    className="px-3 py-2 text-center font-mono font-medium"
                  >
                    {m.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {members.map((from) => (
                <tr key={from.id} className="border-t">
                  <th className="px-3 py-2 text-left font-mono font-medium">
                    {from.name}
                  </th>
                  {members.map((to) =>
                    to.id === from.id ? (
                      <td
                        key={to.id}
                        className="px-3 py-2 text-center text-muted-foreground"
                        aria-hidden
                      >
                        —
                      </td>
                    ) : (
                      <td key={to.id} className="px-3 py-2">
                        <LinkCheckbox
                          from={from}
                          to={to}
                          enabled={isEnabled(from.id, to.id)}
                        />
                      </td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </section>
  );
}
