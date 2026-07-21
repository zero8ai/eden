/**
 * Portal admin — detail (issue #180): the access list (invite / revoke), pinned model, rate +
 * spend limits, enable/disable, and the guest conversation list with a read-only transcript
 * view (portal sessions live in the shared playground tables, so the transcript is a cache
 * read).
 */
import { useEffect, useState } from "react";
import { Globe } from "lucide-react";
import {
  Form,
  Link,
  redirect,
  useFetcher,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { getSessionAuth, sessionLoader } from "~/auth/session.server";
import type { ChatEntry } from "~/chat/types";
import {
  AssistantBubble,
  MarkdownText,
  StepsCard,
  UserBubble,
} from "~/components/chat";
import { ModelSelection } from "~/components/model-select";
import { AgentNav, AppShell, PageHeader, repoCrumbs, SectionHeader } from "~/components/shell";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { LocalizedDate } from "~/components/localized-values";
import { sendPortalInvite } from "~/email/send-portal-invite.server";
import { contextPath } from "~/lib/paths";
import { isReasoningEffort, type ReasoningEffort } from "~/models/reasoning";
import { findWorkspaceModel } from "~/models/union.server";
import { loadPlaygroundEntriesFromCache } from "~/playground/sessions.server";
import { db } from "~/db/client.server";
import { playgroundSessions } from "~/db/schema";
import { and, eq } from "drizzle-orm";
import {
  getPortal,
  listGrants,
  listPortalSessionsWithGuests,
  portalTurnsLast30d,
  revokeGrant,
  setPortalDisabled,
  updatePortalSettings,
  upsertGrant,
} from "~/portal/portals.server";
import { resolveAgentContext } from "~/project/agent-context.server";
import { requireProject, requireRepo } from "~/project/guard.server";
import type { Route } from "./+types/projects.$projectId.portals.$portalId";

export const loader = (args: LoaderFunctionArgs) =>
  sessionLoader(
    args,
    async ({ auth }) => {
      const project = requireRepo(
        await requireProject(auth, args.params.projectId, {
          request: args.request,
        }),
      );
      const portal = args.params.portalId
        ? await getPortal(args.params.portalId, project.id)
        : null;
      if (!portal) throw new Response("Not found", { status: 404 });
      const { roster, isTeam } = await resolveAgentContext(project.id, null);
      const [grants, sessions, turns30d] = await Promise.all([
        listGrants(portal.id),
        listPortalSessionsWithGuests(portal.id),
        portalTurnsLast30d(portal.id),
      ]);

      // Read-only transcript view for one selected guest conversation.
      const selectedSessionId = new URL(args.request.url).searchParams.get(
        "session",
      );
      let transcript: { sessionId: string; entries: ChatEntry[] } | null = null;
      if (selectedSessionId) {
        const [row] = await db
          .select()
          .from(playgroundSessions)
          .where(
            and(
              eq(playgroundSessions.id, selectedSessionId),
              eq(playgroundSessions.portalId, portal.id),
            ),
          )
          .limit(1);
        if (row) {
          transcript = {
            sessionId: row.id,
            entries: await loadPlaygroundEntriesFromCache(row),
          };
        }
      }

      return {
        project: { id: project.id, name: project.name },
        isTeam,
        portal: {
          id: portal.id,
          slug: portal.slug,
          name: portal.name,
          agentName:
            roster.find((a) => a.id === portal.agentId)?.name ?? null,
          modelId: portal.modelId,
          effort: (portal.effort as ReasoningEffort | null) ?? null,
          turnsPerHour: portal.turnsPerHour,
          monthlyTurnCap: portal.monthlyTurnCap,
          disabled: portal.disabledAt !== null,
        },
        grants: grants.map((g) => ({
          id: g.id,
          email: g.email,
          revoked: g.revokedAt !== null,
          createdAt: g.createdAt.toISOString(),
        })),
        sessions: sessions.map((s) => ({
          id: s.id,
          title: s.title ?? "New conversation",
          status: s.status,
          guest: s.guestName || s.guestEmail || "Unknown guest",
          updatedAt: s.updatedAt.toISOString(),
        })),
        turns30d,
        transcript,
      };
    },
    { ensureSignedIn: true },
  );

export async function action(args: ActionFunctionArgs) {
  const auth = await getSessionAuth(args);
  if (!auth.user) throw redirect("/login");
  const project = requireRepo(
    await requireProject(auth, args.params.projectId),
  );
  const portal = args.params.portalId
    ? await getPortal(args.params.portalId, project.id)
    : null;
  if (!portal) throw new Response("Not found", { status: 404 });

  const form = await args.request.formData();
  const intent = String(form.get("intent"));

  if (intent === "invite") {
    const email = String(form.get("email") ?? "")
      .trim()
      .toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { error: "Enter a valid email address." };
    }
    await upsertGrant({ portalId: portal.id, email, invitedBy: auth.user.id });
    try {
      await sendPortalInvite({
        email,
        portalName: portal.name,
        portalSlug: portal.slug,
        inviterName: auth.user.name || auth.user.email,
      });
    } catch (error) {
      console.error(
        `Could not send a portal invite email (${(error as Error)?.name ?? "Error"}).`,
      );
      return {
        ok: true as const,
        warning:
          "Access granted, but the invite email could not be sent — share the portal link directly.",
      };
    }
    return { ok: true as const };
  }

  if (intent === "revoke") {
    const grantId = String(form.get("grantId") ?? "");
    if (grantId) await revokeGrant({ portalId: portal.id, grantId });
    return { ok: true as const };
  }

  if (intent === "set-model") {
    const modelId = String(form.get("modelId") ?? "").trim() || null;
    const effortRaw = String(form.get("effort") ?? "").trim();
    const effort =
      effortRaw && isReasoningEffort(effortRaw) ? effortRaw : null;
    if (modelId && !(await findWorkspaceModel(project.orgId, modelId))) {
      return {
        error:
          "That model is not available from an active provider connection in this workspace.",
      };
    }
    await updatePortalSettings({
      id: portal.id,
      projectId: project.id,
      name: portal.name,
      modelId,
      effort,
      turnsPerHour: portal.turnsPerHour,
      monthlyTurnCap: portal.monthlyTurnCap,
    });
    return { ok: true as const };
  }

  if (intent === "update-settings") {
    const name = String(form.get("name") ?? "").trim();
    if (!name) return { error: "Give the portal a name." };
    const turnsPerHour = Number.parseInt(
      String(form.get("turnsPerHour") ?? ""),
      10,
    );
    if (!Number.isInteger(turnsPerHour) || turnsPerHour < 1 || turnsPerHour > 1000) {
      return { error: "Messages per hour must be between 1 and 1000." };
    }
    const capRaw = String(form.get("monthlyTurnCap") ?? "").trim();
    let monthlyTurnCap: number | null = null;
    if (capRaw) {
      monthlyTurnCap = Number.parseInt(capRaw, 10);
      if (!Number.isInteger(monthlyTurnCap) || monthlyTurnCap < 1) {
        return { error: "The monthly cap must be a positive number (or empty for none)." };
      }
    }
    await updatePortalSettings({
      id: portal.id,
      projectId: project.id,
      name,
      modelId: portal.modelId,
      effort: (portal.effort as ReasoningEffort | null) ?? null,
      turnsPerHour,
      monthlyTurnCap,
    });
    return { ok: true as const };
  }

  if (intent === "toggle-disabled") {
    await setPortalDisabled({
      id: portal.id,
      projectId: project.id,
      disabled: String(form.get("disabled")) === "true",
    });
    return { ok: true as const };
  }

  return { ok: true as const };
}

export function meta() {
  return [{ title: "Portal · eden" }];
}

export default function PortalDetail({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { project, isTeam, portal, grants, sessions, turns30d, transcript } =
    loaderData;
  const base = contextPath(project.id, null);
  const modelFetcher = useFetcher();
  // Absolute URL only after mount — the server doesn't know the browser origin, and
  // rendering it during hydration would mismatch the SSR output.
  const [portalUrl, setPortalUrl] = useState(`/a/${portal.slug}`);
  useEffect(() => {
    setPortalUrl(new URL(`/a/${portal.slug}`, window.location.origin).toString());
  }, [portal.slug]);
  const error =
    actionData && "error" in actionData ? actionData.error : null;
  const warning =
    actionData && "warning" in actionData ? actionData.warning : null;

  return (
    <AppShell
      breadcrumbs={repoCrumbs({
        projectId: project.id,
        repoName: project.name,
        isTeam,
        tail: [
          { label: "Portals", to: `${base}/portals` },
          { label: portal.name },
        ],
      })}
    >
      <div className="mx-auto w-full max-w-5xl px-4 pb-16 pt-8 sm:px-6">
        <AgentNav base={base} level={isTeam ? "repo" : "single"} />
        <PageHeader
          icon={Globe}
          accent="emerald"
          title={
            <span className="flex items-center gap-2">
              {portal.name}
              {portal.disabled && <Badge variant="secondary">Disabled</Badge>}
              {isTeam && portal.agentName && (
                <Badge variant="outline">{portal.agentName}</Badge>
              )}
            </span>
          }
          description={
            <span>
              Guests chat at{" "}
              <a
                href={portalUrl}
                target="_blank"
                rel="noreferrer"
                className="font-mono underline underline-offset-2"
              >
                {portalUrl}
              </a>
              {" · "}
              {turns30d} message{turns30d === 1 ? "" : "s"} in the last 30 days
            </span>
          }
          actions={
            <Form method="post">
              <input type="hidden" name="intent" value="toggle-disabled" />
              <input
                type="hidden"
                name="disabled"
                value={portal.disabled ? "false" : "true"}
              />
              <Button
                type="submit"
                variant={portal.disabled ? "default" : "outline"}
                size="sm"
              >
                {portal.disabled ? "Enable portal" : "Disable portal"}
              </Button>
            </Form>
          }
        />

        {error && <p className="mb-4 text-sm text-destructive">{error}</p>}
        {warning && <p className="mb-4 text-sm text-amber-600">{warning}</p>}

        <section className="mb-10">
          <SectionHeader title="Access" />
          <Form method="post" className="mb-4 flex flex-wrap items-end gap-3">
            <input type="hidden" name="intent" value="invite" />
            <div className="min-w-64 space-y-2">
              <Label htmlFor="invite-email">Invite by email</Label>
              <Input
                id="invite-email"
                name="email"
                type="email"
                placeholder="jaden@company.com"
                required
              />
            </div>
            <Button type="submit">Invite</Button>
          </Form>
          <div className="divide-y rounded-lg border">
            {grants.map((grant) => (
              <div
                key={grant.id}
                className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm"
              >
                <span className={grant.revoked ? "text-muted-foreground line-through" : ""}>
                  {grant.email}
                </span>
                <span className="flex items-center gap-3">
                  <span className="text-xs text-muted-foreground">
                    <LocalizedDate
                      value={new Date(grant.createdAt)}
                      options={{ month: "short", day: "numeric" }}
                    />
                  </span>
                  {grant.revoked ? (
                    <Form method="post">
                      <input type="hidden" name="intent" value="invite" />
                      <input type="hidden" name="email" value={grant.email} />
                      <Button type="submit" variant="outline" size="sm">
                        Re-invite
                      </Button>
                    </Form>
                  ) : (
                    <Form method="post">
                      <input type="hidden" name="intent" value="revoke" />
                      <input type="hidden" name="grantId" value={grant.id} />
                      <Button type="submit" variant="outline" size="sm">
                        Revoke
                      </Button>
                    </Form>
                  )}
                </span>
              </div>
            ))}
            {grants.length === 0 && (
              <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                Nobody has access yet — invite an email above.
              </p>
            )}
          </div>
        </section>

        <section className="mb-10">
          <SectionHeader title="Model & limits" />
          <div className="flex flex-wrap items-center gap-3">
            <ModelSelection
              model={portal.modelId}
              effort={portal.effort}
              busy={modelFetcher.state !== "idle"}
              placeholder="Deployed default model"
              onCommit={(model, effort) =>
                modelFetcher.submit(
                  { intent: "set-model", modelId: model, effort: effort ?? "" },
                  { method: "post" },
                )
              }
            />
            {portal.modelId && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  modelFetcher.submit(
                    { intent: "set-model", modelId: "", effort: "" },
                    { method: "post" },
                  )
                }
              >
                Use deployed default
              </Button>
            )}
            <p className="w-full text-xs text-muted-foreground">
              Guests always talk to this model — they get no selector and no
              deployment awareness.
            </p>
          </div>
          <Form
            method="post"
            className="mt-4 flex flex-wrap items-end gap-3"
          >
            <input type="hidden" name="intent" value="update-settings" />
            <div className="space-y-2">
              <Label htmlFor="portal-rename">Name</Label>
              <Input
                id="portal-rename"
                name="name"
                defaultValue={portal.name}
                className="w-56"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="turns-per-hour">Messages / hour / guest</Label>
              <Input
                id="turns-per-hour"
                name="turnsPerHour"
                type="number"
                min={1}
                max={1000}
                defaultValue={portal.turnsPerHour}
                className="w-40"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="monthly-cap">Monthly cap (all guests)</Label>
              <Input
                id="monthly-cap"
                name="monthlyTurnCap"
                type="number"
                min={1}
                placeholder="No cap"
                defaultValue={portal.monthlyTurnCap ?? ""}
                className="w-40"
              />
            </div>
            <Button type="submit" variant="outline">
              Save
            </Button>
          </Form>
        </section>

        <section>
          <SectionHeader title="Conversations" />
          <div className="divide-y rounded-lg border">
            {sessions.map((s) => (
              <Link
                key={s.id}
                to={`?session=${encodeURIComponent(s.id)}`}
                preventScrollReset
                className={`flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm transition-colors hover:bg-accent ${
                  transcript?.sessionId === s.id ? "bg-accent" : ""
                }`}
              >
                <span className="min-w-0 truncate">{s.title}</span>
                <span className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
                  <span>{s.guest}</span>
                  <Badge variant="outline">{s.status}</Badge>
                  <LocalizedDate
                    value={new Date(s.updatedAt)}
                    options={{ month: "short", day: "numeric" }}
                  />
                </span>
              </Link>
            ))}
            {sessions.length === 0 && (
              <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                No guest conversations yet.
              </p>
            )}
          </div>

          {transcript && (
            <div className="mt-6 space-y-4 rounded-lg border bg-muted/20 p-4">
              {transcript.entries.map((e) =>
                e.role === "user" ? (
                  <UserBubble key={e.id} text={e.text} />
                ) : (
                  <div key={e.id} className="space-y-2">
                    <AssistantBubble>
                      {e.structured ? (
                        <pre className="overflow-x-auto rounded-lg bg-muted/50 p-3 font-mono text-xs">
                          {e.text}
                        </pre>
                      ) : (
                        <MarkdownText text={e.text || "(empty reply)"} />
                      )}
                    </AssistantBubble>
                    <StepsCard steps={e.steps ?? []} idPrefix={e.id} />
                  </div>
                ),
              )}
              {transcript.entries.length === 0 && (
                <p className="py-4 text-center text-sm text-muted-foreground">
                  This conversation has no messages yet.
                </p>
              )}
            </div>
          )}
        </section>
      </div>
    </AppShell>
  );
}
