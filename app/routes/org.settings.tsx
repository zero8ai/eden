/**
 * Org governance (managed mode — PRD §7.5, ARCH §3.8). Spend cap + kill-switch, month-to-date
 * token usage, and the operational audit log. Org-scoped; roles/SSO are delegated to WorkOS.
 */
import { authkitLoader, withAuth } from "@workos-inc/authkit-react-router";
import {
  Form,
  Link,
  redirect,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { AppShell, PageHeader } from "~/components/shell";
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
import { listAudit, recordAudit } from "~/managed/audit.server";
import {
  getSpendLimit,
  setSpendLimit,
  tokensUsedSince,
  type SpendLimit,
} from "~/managed/billing.server";
import { getRuntime } from "~/seams/index.server";
import type { auditLog } from "~/db/schema";
import type { EdenMode } from "~/seams/types";
import type { Route } from "./+types/org.settings";

interface OrgSettingsView {
  org: Org | null;
  mode: EdenMode;
  limit: SpendLimit | null;
  used: number;
  audit: (typeof auditLog.$inferSelect)[];
}

export const loader = (args: LoaderFunctionArgs) =>
  authkitLoader(
    args,
    async ({ auth }): Promise<OrgSettingsView> => {
      const { org } = await syncTenant({
        user: auth.user,
        organizationId: auth.organizationId,
        role: auth.role,
      });
      if (!org) return { org: null, mode: getRuntime().mode, limit: null, used: 0, audit: [] };
      const [limit, used, audit] = await Promise.all([
        getSpendLimit(org.id),
        tokensUsedSince(org.id),
        listAudit(org.id, 50),
      ]);
      return { org, mode: getRuntime().mode, limit: limit ?? null, used, audit };
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
  return [{ title: "Org settings · Eden" }];
}

export default function OrgSettings({ loaderData }: Route.ComponentProps) {
  const { user, org, mode, limit, used, audit } = loaderData;

  if (!org) {
    return (
      <AppShell userEmail={user?.email}>
        <PageHeader
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
    <AppShell workspaceName={org.name} userEmail={user?.email}>
      <PageHeader
        title={`${org.name} — settings`}
        description={
          <>
            Mode: <span className="font-mono">{mode}</span>. Roles &amp; SSO are
            managed in WorkOS.
          </>
        }
      />

      <div className="space-y-6">
        {/* Spend controls */}
        <Card>
          <CardHeader>
            <CardTitle>Spend controls</CardTitle>
            <CardDescription>
              Tokens used (last 30 days):{" "}
              <span className="font-medium text-foreground">
                {used.toLocaleString()}
              </span>
              {limit?.monthlyTokenCap != null &&
                ` / ${limit.monthlyTokenCap.toLocaleString()}`}
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
              <Label className="flex items-center gap-2 font-normal">
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
            <CardTitle>Audit log</CardTitle>
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
                      {new Date(a.createdAt).toLocaleString()}
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
