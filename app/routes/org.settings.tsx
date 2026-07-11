/**
 * Org governance (managed mode — PRD §7.5, ARCH §3.8). Spend cap + kill-switch, month-to-date
 * token usage, and the operational audit log. Workspace membership is managed by Better Auth's
 * organization plugin.
 */
import { getSessionAuth, sessionLoader } from "~/auth/session.server";
import { Building2, Cpu, Gauge, Plug, ScrollText, ShieldAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  Form,
  Link,
  redirect,
  useFetcher,
  useRevalidator,
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
import { SecretInput } from "~/components/ui/secret-input";
import { Label } from "~/components/ui/label";
import {
  ensureWorkspace,
  resolveActiveWorkspace,
  type WorkspaceInfo,
} from "~/auth/workspace.server";
import { listAudit, recordAudit } from "~/managed/audit.server";
import {
  getWorkspaceAssistantModel,
  hasWorkspaceModelKey,
  setWorkspaceAssistantModel,
  setWorkspaceModelKey,
} from "~/org/workspace.server";
import {
  deleteModelConnection,
  listModelConnections,
  renameModelConnection,
  type ModelConnection,
} from "~/models/provider-connections.server";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
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
import { auth as betterAuth } from "~/lib/auth.server";
import type { Route } from "./+types/org.settings";

interface OrgSettingsView {
  org: WorkspaceInfo | null;
  mode: EdenMode;
  limit: SpendLimit | null;
  used: number;
  audit: (typeof auditLog.$inferSelect)[];
  /** A workspace OpenRouter key is configured (value never leaves the server). */
  hasModelKey: boolean;
  /** Workspace default OpenRouter model id (null = Eden default). */
  assistantModel: string | null;
  /** Connected model providers (issue #28) — display metadata only, never a token. */
  connections: ModelConnection[];
  /** Better Auth organization:update permission for the active workspace. */
  canManage: boolean;
}

async function canManageWorkspace(
  organizationId: string,
  headers: Headers,
): Promise<boolean> {
  const permission = await betterAuth.api.hasPermission({
    headers,
    body: {
      organizationId,
      permissions: { organization: ["update"] },
    },
  });
  return permission.success;
}

export const loader = (args: LoaderFunctionArgs) =>
  sessionLoader(
    args,
    async ({ auth }): Promise<OrgSettingsView> => {
      // Close the org-less hole: provision/adopt/choose a workspace before syncing.
      await ensureWorkspace(args.request, auth);
      const active = await resolveActiveWorkspace(auth);
      const org = active?.org;
      if (!org) {
        return {
          org: null,
          mode: getRuntime().mode,
          limit: null,
          used: 0,
          audit: [],
          hasModelKey: false,
          assistantModel: null,
          connections: [],
          canManage: false,
        };
      }
      const [
        limit,
        used,
        audit,
        hasModelKey,
        assistantModel,
        connections,
        canManage,
      ] = await Promise.all([
        getSpendLimit(org.id),
        tokensUsedSince(org.id),
        listAudit(org.id, 50),
        hasWorkspaceModelKey(org.id),
        getWorkspaceAssistantModel(org.id),
        listModelConnections(org.id),
        canManageWorkspace(org.id, auth.requestHeaders),
      ]);
      return {
        org,
        mode: getRuntime().mode,
        limit: limit ?? null,
        used,
        audit,
        hasModelKey,
        assistantModel,
        connections,
        canManage,
      };
    },
    { ensureSignedIn: true },
  );

export async function action(args: ActionFunctionArgs) {
  const auth = await getSessionAuth(args);
  if (!auth.user) throw redirect("/login");
  const active = await resolveActiveWorkspace(auth);
  const org = active?.org;
  if (!org) return { error: "No organization." };
  if (!(await canManageWorkspace(org.id, auth.requestHeaders))) {
    throw new Response("Forbidden", { status: 403 });
  }

  const form = await args.request.formData();

  // ── Workspace model key: set or clear the org's OpenRouter key ──
  const intent = String(form.get("intent") ?? "");
  if (intent === "set-model-key" || intent === "clear-model-key") {
    const value =
      intent === "set-model-key"
        ? String(form.get("modelKey") ?? "").trim()
        : "";
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

  // ── Model provider connections (issue #28): rename / remove a connected provider ──
  if (intent === "rename-connection") {
    const id = String(form.get("connectionId") ?? "");
    const label = String(form.get("label") ?? "").trim();
    if (!id || !label) return { error: "Give the connection a name." };
    await renameModelConnection(org.id, id, label);
    await recordAudit({
      orgId: org.id,
      actorUserId: auth.user.id,
      action: "model_provider_renamed",
      target: id,
    });
    throw redirect("/org/settings");
  }

  if (intent === "remove-connection") {
    const id = String(form.get("connectionId") ?? "");
    if (!id) return { error: "No connection specified." };
    await deleteModelConnection(org.id, id);
    await recordAudit({
      orgId: org.id,
      actorUserId: auth.user.id,
      action: "model_provider_removed",
      target: id,
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
  const monthlyTokenCap =
    capRaw === "" ? null : Math.max(0, Number(capRaw) || 0);
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
  return [{ title: "Org settings · eden" }, ...noindexMeta];
}

export default function OrgSettings({ loaderData }: Route.ComponentProps) {
  const {
    user,
    org,
    mode,
    limit,
    used,
    audit,
    hasModelKey,
    assistantModel,
    connections,
    canManage,
  } = loaderData;
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
            Mode: <span className="font-mono">{mode}</span>. Authentication and
            organization roles are managed by Better Auth.
          </>
        }
      />

      <div className="space-y-6">
        {/* Model provider: OpenRouter key + default model for authoring and agents */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Cpu className={`size-4 ${accentText.blue}`} aria-hidden />
              Model providers
            </CardTitle>
            <CardDescription>
              OpenRouter is the default model provider. eden injects this key as{" "}
              <span className="font-mono">OPENROUTER_API_KEY</span> for
              deployments, and the default model below is used by the authoring
              assistant and by agents that do not have their own model set. You
              can also connect an OpenAI Codex subscription — its models then
              appear in every model picker as{" "}
              <span className="font-mono">codex/&lt;connection&gt;/&lt;model&gt;</span>,
              alongside OpenRouter.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!canManage ? (
              <div className="space-y-2 text-sm">
                <p>OpenRouter key: {hasModelKey ? "configured" : "not set"}</p>
                <p>Default model: {assistantModel ?? "eden default"}</p>
                <p className="text-muted-foreground">
                  Only workspace owners and admins can change model provider
                  settings.
                </p>
              </div>
            ) : hasModelKey ? (
              <Form method="post" className="flex flex-wrap items-center gap-3">
                <input type="hidden" name="intent" value="clear-model-key" />
                <p className="text-sm">
                  OpenRouter key:{" "}
                  <span className="font-medium">configured</span>{" "}
                  <span className="text-muted-foreground">
                    (write-only; value never shown)
                  </span>
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
                  <SecretInput
                    id="modelKey"
                    name="modelKey"
                    placeholder="sk-or-v1-…"
                    revealLabel="API key"
                    wrapperClassName="w-full"
                    className="w-full"
                  />
                </div>
                <Button type="submit">Save key</Button>
              </Form>
            )}

            {canManage && (
              <div className="mt-6 max-w-xl space-y-2 border-t pt-4">
                <Label>Default model</Label>
                <div className="flex flex-wrap items-center gap-2">
                  <ModelSelect
                    value={assistantModel}
                    busy={modelFetcher.state !== "idle"}
                    onCommit={(model) =>
                      modelFetcher.submit(
                        {
                          intent: "set-assistant-model",
                          assistantModel: model,
                        },
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
            )}

            {/* Connected providers (issue #28): OpenAI Codex subscriptions */}
            <div className="mt-6 space-y-3 border-t pt-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Label className="flex items-center gap-2">
                  <Plug className="size-4" aria-hidden />
                  Connected providers
                </Label>
                {canManage && <ConnectCodexDialog />}
              </div>
              {connections.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No provider accounts connected. OpenRouter (above) still works
                  on its own; connect an OpenAI Codex subscription to run agents
                  on your ChatGPT plan.
                </p>
              ) : (
                <ul className="divide-y rounded-lg border text-sm">
                  {connections.map((conn) => (
                    <ConnectionRow
                      key={conn.id}
                      conn={conn}
                      canManage={canManage}
                    />
                  ))}
                </ul>
              )}
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
            {canManage ? (
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
            ) : (
              <div className="space-y-2 text-sm">
                <p>
                  Monthly token cap:{" "}
                  {limit?.monthlyTokenCap?.toLocaleString() ?? "unlimited"}
                </p>
                <p>Kill-switch: {limit?.killSwitch ? "on" : "off"}</p>
                <p className="text-muted-foreground">
                  Only workspace owners and admins can change spend controls.
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Audit log */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ScrollText
                className={`size-4 ${accentText.indigo}`}
                aria-hidden
              />
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

/** One connected model provider — provider badge, inline rename, status, remove (issue #28). */
function ConnectionRow({
  conn,
  canManage,
}: {
  conn: ModelConnection;
  canManage: boolean;
}) {
  const rename = useFetcher();
  const [editing, setEditing] = useState(false);
  const active = conn.status === "active";
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
      <div className="space-y-0.5">
        <div className="flex items-center gap-2">
          <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium">
            OpenAI Codex
          </span>
          {editing && canManage ? (
            <rename.Form
              method="post"
              className="flex items-center gap-1"
              onSubmit={() => setEditing(false)}
            >
              <input type="hidden" name="intent" value="rename-connection" />
              <input type="hidden" name="connectionId" value={conn.id} />
              <Input
                name="label"
                defaultValue={conn.label}
                aria-label="Connection name"
                className="h-7 w-40"
              />
              <Button type="submit" size="sm">
                Save
              </Button>
            </rename.Form>
          ) : (
            <span className="font-medium">{conn.label}</span>
          )}
          {canManage && !editing && (
            <button
              type="button"
              className="text-xs text-muted-foreground underline"
              onClick={() => setEditing(true)}
            >
              rename
            </button>
          )}
        </div>
        {conn.accountEmail && (
          <p className="text-xs text-muted-foreground">{conn.accountEmail}</p>
        )}
        {!active && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            Reconnect needed — this connection is {conn.status}.
          </p>
        )}
      </div>
      {canManage && (
        <Form method="post">
          <input type="hidden" name="intent" value="remove-connection" />
          <input type="hidden" name="connectionId" value={conn.id} />
          <Button type="submit" variant="outline" size="sm">
            Remove
          </Button>
        </Form>
      )}
    </li>
  );
}

type CodexConnectResponse =
  | { deviceAuthId: string; userCode: string; interval: number; verificationUrl: string }
  | { pending: true }
  | { done: true }
  | { error: string };

/**
 * The "Connect OpenAI Codex" dialog (issue #28): request a device code, show the user the code +
 * verification URL, then poll until they authorize — closing and revalidating on success so the
 * connections list refreshes.
 */
function ConnectCodexDialog() {
  const [open, setOpen] = useState(false);
  const fetcher = useFetcher<CodexConnectResponse>();
  const revalidator = useRevalidator();
  const [device, setDevice] = useState<{
    deviceAuthId: string;
    userCode: string;
    verificationUrl: string;
    interval: number;
  } | null>(null);
  const started = useRef(false);

  // Kick off the device-code request once per open.
  useEffect(() => {
    if (open && !started.current) {
      started.current = true;
      fetcher.submit(
        { intent: "start" },
        { method: "post", action: "/api/connections/codex" },
      );
    }
    if (!open) {
      started.current = false;
      setDevice(null);
    }
    // fetcher is stable for the component's lifetime; re-running on it would resubmit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Latch the device code, complete on success — both driven by the fetcher response.
  useEffect(() => {
    const d = fetcher.data;
    if (!d) return;
    if ("deviceAuthId" in d && d.deviceAuthId) {
      setDevice({
        deviceAuthId: d.deviceAuthId,
        userCode: d.userCode,
        verificationUrl: d.verificationUrl,
        interval: d.interval,
      });
    }
    if ("done" in d && d.done) {
      setOpen(false);
      setDevice(null);
      revalidator.revalidate();
    }
  }, [fetcher.data, revalidator]);

  // Poll for authorization at the server-provided interval while the dialog is open.
  useEffect(() => {
    if (!open || !device) return;
    const timer = setInterval(
      () => {
        fetcher.submit(
          {
            intent: "poll",
            deviceAuthId: device.deviceAuthId,
            userCode: device.userCode,
          },
          { method: "post", action: "/api/connections/codex" },
        );
      },
      Math.max(device.interval, 1) * 1000,
    );
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, device]);

  const error =
    fetcher.data && "error" in fetcher.data ? fetcher.data.error : null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" size="sm">
          Connect OpenAI Codex
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect OpenAI Codex</DialogTitle>
          <DialogDescription>
            Sign in with your ChatGPT subscription to run agents on your Codex
            plan.
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>
        ) : device ? (
          <div className="space-y-3">
            <p className="text-sm">Enter this code to authorize eden:</p>
            <p className="text-center font-mono text-3xl font-semibold tracking-widest">
              {device.userCode}
            </p>
            <p className="text-sm">
              Open{" "}
              <a
                href={device.verificationUrl}
                target="_blank"
                rel="noreferrer"
                className="font-medium underline"
              >
                {device.verificationUrl}
              </a>{" "}
              and enter the code. Waiting for you to authorize…
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Starting…</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
