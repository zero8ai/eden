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
  const { org, mode, limit, used, audit } = loaderData;

  if (!org) {
    return (
      <main className="min-h-screen px-6 py-12">
        <div className="mx-auto max-w-3xl">
          <Link to="/dashboard" className="text-sm text-gray-500 underline">
            ← Dashboard
          </Link>
          <p className="mt-6 text-sm text-gray-600 dark:text-gray-300">
            You&rsquo;re not scoped to an organization.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen px-6 py-12 text-gray-900 dark:text-gray-100">
      <div className="mx-auto max-w-3xl">
        <Link
          to="/dashboard"
          className="text-sm font-medium uppercase tracking-widest text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"
        >
          ← Dashboard
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          {org.name} — settings
        </h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Mode: <span className="font-mono">{mode}</span>. Roles &amp; SSO are managed in
          WorkOS.
        </p>

        {/* Spend controls */}
        <section className="mt-8 rounded-xl border border-gray-200 p-5 dark:border-gray-800">
          <h2 className="text-lg font-semibold">Spend controls</h2>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Tokens used (last 30 days):{" "}
            <span className="font-medium">{used.toLocaleString()}</span>
            {limit?.monthlyTokenCap != null && ` / ${limit.monthlyTokenCap.toLocaleString()}`}
          </p>
          <Form method="post" className="mt-4 space-y-3">
            <div>
              <label className="block text-sm font-medium">Monthly token cap</label>
              <input
                name="monthlyTokenCap"
                type="number"
                min={0}
                defaultValue={limit?.monthlyTokenCap ?? ""}
                placeholder="unlimited"
                className="mt-1 w-48 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="killSwitch"
                defaultChecked={limit?.killSwitch ?? false}
              />
              Kill-switch (block all model calls for this tenant)
            </label>
            <button
              type="submit"
              className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
            >
              Save
            </button>
          </Form>
        </section>

        {/* Audit log */}
        <section className="mt-8">
          <h2 className="text-lg font-semibold">Audit log</h2>
          {audit.length === 0 ? (
            <p className="mt-2 text-sm text-gray-400">No operations recorded yet.</p>
          ) : (
            <ul className="mt-2 divide-y divide-gray-200 rounded-xl border border-gray-200 text-sm dark:divide-gray-800 dark:border-gray-800">
              {audit.map((a) => (
                <li key={a.id} className="flex justify-between px-4 py-2">
                  <span>
                    <span className="font-medium">{a.action}</span>
                    {a.target && <span className="ml-2 font-mono text-gray-500">{a.target}</span>}
                  </span>
                  <span className="text-gray-400">
                    {new Date(a.createdAt).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
