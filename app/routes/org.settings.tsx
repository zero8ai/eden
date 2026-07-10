/**
 * Org governance (managed mode — PRD §7.5, ARCH §3.8). Spend cap + kill-switch, month-to-date
 * token usage, and the operational audit log. Org-scoped; roles/SSO are delegated to WorkOS.
 */
import { authkitLoader, withAuth } from "@workos-inc/authkit-react-router";
import { Building2, Cpu, Gauge, ScrollText, ShieldAlert } from "lucide-react";
import {
  Form,
  Link,
  redirect,
  useFetcher,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import {
  LocalizedDateTime,
  LocalizedNumber,
} from "~/components/localized-values";
import { ModelSelect } from "~/components/model-select";
import { AppShell, PageHeader, accentText } from "~/components/shell";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { syncTenant, type Org } from "~/auth/tenant.server";
import { ensureWorkspace } from "~/auth/workspace.server";
import { listAudit, recordAudit } from "~/managed/audit.server";
import {
  getWorkspaceAssistantModel,
  hasWorkspaceModelKey,
  setWorkspaceAssistantModel,
  setWorkspaceModelKey,
} from "~/org/workspace.server";
import {
  getSpendLimit,
  setSpendLimit,
  tokensUsedSince,
  type SpendLimit,
} from "~/managed/billing.server";
import { getRuntime } from "~/seams/index.server";
import type { auditLog } from "~/db/schema";
import type { EdenMode } from "~/seams/types";
import { noindexMeta } from "~/lib/seo";
import type { Route } from "./+types/org.settings";

interface OrgSettingsView {
  org: Org | null;
  mode: EdenMode;
  limit: SpendLimit | null;
  used: number;
  audit: (typeof auditLog.$inferSelect)[];
  /** A workspace OpenRouter key is configured (value never leaves the server). */
  hasModelKey: boolean;
  /** Workspace default OpenRouter model id (null = Eden default). */
  assistantModel: string | null;
}

export const loader = (args: LoaderFunctionArgs) =>
  authkitLoader(
    args,
    async ({ auth }): Promise<OrgSettingsView> => {
      // Close the org-less hole: provision/adopt/choose a workspace before syncing.
      await ensureWorkspace(args.request, auth);
      const { org } = await syncTenant({
        user: auth.user,
        organizationId: auth.organizationId,
        role: auth.role,
      });
      if (!org) {
        return {
          org: null,
          mode: getRuntime().mode,
          limit: null,
          used: 0,
          audit: [],
          hasModelKey: false,
          assistantModel: null,
        };
      }
      const [limit, used, audit, hasModelKey, assistantModel] = await Promise.all([
        getSpendLimit(org.id),
        tokensUsedSince(org.id),
        listAudit(org.id, 50),
        hasWorkspaceModelKey(org.id),
        getWorkspaceAssistantModel(org.id),
      ]);
      return {
        org,
        mode: getRuntime().mode,
        limit: limit ?? null,
        used,
        audit,
        hasModelKey,
        assistantModel,
      };
    },
    { ensureSignedIn: true },
  );

export async function action(args: ActionFunctionArgs) {
  const auth = await withAuth(args);
  if (!auth.user) throw redirect("/login");
  const { org } = await syncTenant({
    user: auth.user,
    organizationId: auth.organizationId ?? null,
    role: auth.role ?? null,
  });
  if (!org) return { error: "No organization." };

  const form = await args.request.formData();

  // ── Workspace model key: set or clear the org's OpenRouter key ──
  const intent = String(form.get("intent") ?? "");
  if (intent === "set-model-key" || intent === "clear-model-key") {
    const value =
      intent === "set-model-key" ? String(form.get("modelKey") ?? "").trim() : "";
    if (intent === "set-model-key" && !value) {
      return { error: "Paste an OpenRouter API key." };
    }
    await setWorkspaceModelKey(org.id, value || null);
    await recordAudit({
      orgId: org.id,
      actorUserId: auth.user.id,
      action: value ? "workspace_model_key_set" : "workspace_model_key_cleared",
    });
    throw redirect("/org/settings");
  }

  if (intent === "set-assistant-model") {
    const model = String(form.get("assistantModel") ?? "").trim();
    await setWorkspaceAssistantModel(org.id, model || null);
    await recordAudit({
      orgId: org.id,
      actorUserId: auth.user.id,
      action: "workspace_assistant_model_set",
      meta: { model: model || "(default)" },
    });
    throw redirect("/org/settings");
  }

  const capRaw = String(form.get("monthlyTokenCap") ?? "").trim();
  const monthlyTokenCap = capRaw === "" ? null : Math.max(0, Number(capRaw) || 0);
  const killSwitch = form.get("killSwitch") === "on";

  await setSpendLimit(org.id, { monthlyTokenCap, killSwitch });
  await recordAudit({
    orgId: org.id,
    actorUserId: auth.user.id,
    action: "spend_limit_change",
    meta: { monthlyTokenCap, killSwitch },
  });
  throw redirect("/org/settings");
}

export function meta() {
  return [
    { title: "Org settings · eden" },
    ...noindexMeta,
  ];
}

export default function OrgSettings({ loaderData }: Route.ComponentProps) {
  const { user, org, mode, limit, used, audit, hasModelKey, assistantModel } = loaderData;
  const modelFetcher = useFetcher<typeof action>();

  if (!org) {
    return (
      <AppShell userEmail={user?.email}>
        <PageHeader
          icon={Building2}
          accent="indigo"
          title="Settings"
          description="You're not scoped to an organization."
        />
        <Button variant="outline" asChild>
          <Link to="/dashboard">Back to dashboard</Link>
        </Button>
      </AppShell>
    );
  }

  return (
    <AppShell userEmail={user?.email}>
      <PageHeader
        icon={Building2}
        accent="indigo"
        title="Settings"
        description={
          <>
            Mode: <span className="font-mono">{mode}</span>. Roles &amp; SSO are
            managed in WorkOS.
          </>
        }
      />

      <div className="space-y-6">
        {/* Model provider: OpenRouter key + default model for authoring and agents */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Cpu className={`size-4 ${accentText.blue}`} aria-hidden />
              Model provider
            </CardTitle>
            <CardDescription>
              OpenRouter is the default model provider. eden injects this key as{" "}
              <span className="font-mono">OPENROUTER_API_KEY</span> for deployments,
              and the default model below is used by the authoring assistant and by
              agents that do not have their own model set.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {hasModelKey ? (
              <Form method="post" className="flex flex-wrap items-center gap-3">
                <input type="hidden" name="intent" value="clear-model-key" />
                <p className="text-sm">
                  OpenRouter key: <span className="font-medium">configured</span>{" "}
                  <span className="text-muted-foreground">(write-only; value never shown)</span>
                </p>
                <Button type="submit" variant="outline" size="sm">
                  Remove key
                </Button>
              </Form>
            ) : (
              <Form method="post" className="flex max-w-xl items-end gap-2">
                <input type="hidden" name="intent" value="set-model-key" />
                <div className="flex-1 space-y-1.5">
                  <Label htmlFor="modelKey">OpenRouter API key</Label>
                  <Input
                    id="modelKey"
                    name="modelKey"
                    type="password"
                    placeholder="sk-or-v1-…"
                    autoComplete="off"
                  />
                </div>
                <Button type="submit">Save key</Button>
              </Form>
            )}

            <div className="mt-6 max-w-xl space-y-2 border-t pt-4">
              <Label>Default model</Label>
              <div className="flex flex-wrap items-center gap-2">
                <ModelSelect
                  value={assistantModel}
                  busy={modelFetcher.state !== "idle"}
                  onCommit={(model) =>
                    modelFetcher.submit(
                      { intent: "set-assistant-model", assistantModel: model },
                      { method: "post" },
                    )
                  }
                />
                {assistantModel && (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={modelFetcher.state !== "idle"}
                    onClick={() =>
                      modelFetcher.submit(
                        { intent: "set-assistant-model", assistantModel: "" },
                        { method: "post" },
                      )
                    }
                  >
                    Use eden default
                  </Button>
                )}
              </div>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">
                  Any OpenRouter model id. Needs tool-calling support for
                  tool-using agents.
                </p>
                {!assistantModel && (
                  <p className="text-xs text-muted-foreground">
                    No workspace default set; eden's built-in default is used.
                  </p>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Spend controls */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Gauge className={`size-4 ${accentText.amber}`} aria-hidden />
              Spend controls
            </CardTitle>
            <CardDescription>
              Tokens used (last 30 days):{" "}
              <span className={`font-medium ${accentText.indigo}`}>
                <LocalizedNumber value={used} />
              </span>
              {limit?.monthlyTokenCap != null && (
                <>
                  {" / "}
                  <LocalizedNumber value={limit.monthlyTokenCap} />
                </>
              )}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Form method="post" className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="monthlyTokenCap">Monthly token cap</Label>
                <Input
                  id="monthlyTokenCap"
                  name="monthlyTokenCap"
                  type="number"
                  min={0}
                  defaultValue={limit?.monthlyTokenCap ?? ""}
                  placeholder="unlimited"
                  className="w-48"
                />
              </div>
              <Label className="flex items-center gap-2 rounded-lg border border-rose-500/30 bg-rose-500/5 px-3 py-2 font-normal text-rose-700 dark:text-rose-400">
                <ShieldAlert className="size-4 shrink-0" aria-hidden />
                <input
                  type="checkbox"
                  name="killSwitch"
                  defaultChecked={limit?.killSwitch ?? false}
                  aria-label="Kill-switch (block all model calls for this tenant)"
                />
                Kill-switch (block all model calls for this tenant)
              </Label>
              <Button type="submit">Save</Button>
            </Form>
          </CardContent>
        </Card>

        {/* Audit log */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ScrollText className={`size-4 ${accentText.indigo}`} aria-hidden />
              Audit log
            </CardTitle>
          </CardHeader>
          <CardContent>
            {audit.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No operations recorded yet.
              </p>
            ) : (
              <ul className="divide-y rounded-lg border text-sm">
                {audit.map((a) => (
                  <li key={a.id} className="flex justify-between px-4 py-2">
                    <span>
                      <span className="font-medium">{a.action}</span>
                      {a.target && (
                        <span className="ml-2 font-mono text-muted-foreground">
                          {a.target}
                        </span>
                      )}
                    </span>
                    <span className="text-muted-foreground">
                      <LocalizedDateTime value={a.createdAt} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
