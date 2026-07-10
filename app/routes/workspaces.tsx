/**
 * Workspace chooser + switch endpoint (issue #56).
 *
 * A user who belongs to more than one workspace picks one here at sign-in; `ensureWorkspace`
 * redirects org-less multi-workspace sessions to `/workspaces?returnTo=…`. The same POST action
 * is the switch endpoint used by the in-app workspace menu — it re-mints the session against the
 * chosen org via WorkOS's refresh grant (which validates membership) and redirects on.
 *
 * This route must NEVER call `ensureWorkspace`: it is the target of that redirect, so doing so
 * would loop. It reads the user's live WorkOS memberships directly.
 */
import { authkitLoader, switchToOrganization } from "@workos-inc/authkit-react-router";
import { Check } from "lucide-react";
import {
  Form,
  redirect,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { AppShell } from "~/components/shell";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { listUserWorkspaces } from "~/auth/workspace.server";
import { noindexMeta } from "~/lib/seo";
import type { Route } from "./+types/workspaces";

/** Only allow same-site absolute paths as a post-switch destination (never an open redirect). */
function safeReturnTo(raw: string | null | undefined): string {
  if (raw && raw.startsWith("/") && !raw.startsWith("//")) return raw;
  return "/dashboard";
}

export const loader = (args: LoaderFunctionArgs) =>
  authkitLoader(
    args,
    async ({ auth }) => {
      const workspaces = await listUserWorkspaces(auth.user.id);
      const url = new URL(args.request.url);
      const returnTo = safeReturnTo(url.searchParams.get("returnTo"));

      // No workspaces at all → let the dashboard provision one (ensureWorkspace).
      if (workspaces.length === 0) throw redirect("/dashboard");

      // A single-workspace user should never see a picker: if the session isn't scoped yet,
      // enter that one workspace and continue to where they were headed.
      if (workspaces.length === 1 && !auth.organizationId) {
        const result = await switchToOrganization(args.request, workspaces[0].id, {
          returnTo,
        });
        if (result instanceof Response) throw result;
        throw redirect("/dashboard");
      }

      return { workspaces, currentOrgId: auth.organizationId, returnTo };
    },
    { ensureSignedIn: true },
  );

export async function action(args: ActionFunctionArgs) {
  const form = await args.request.formData();
  const orgId = String(form.get("orgId") ?? "");
  const returnTo = safeReturnTo(String(form.get("returnTo") ?? ""));
  if (!orgId) throw redirect("/workspaces");

  // WorkOS validates membership during the refresh grant; a non-member just fails to switch.
  const result = await switchToOrganization(args.request, orgId, { returnTo });
  if (result instanceof Response) return result;
  // The switch didn't take (not a member, token issue) — back to the chooser, no crash.
  throw redirect("/workspaces");
}

export function meta() {
  return [{ title: "Choose a workspace · eden" }, ...noindexMeta];
}

export default function Workspaces({ loaderData }: Route.ComponentProps) {
  const { user, workspaces, currentOrgId, returnTo } = loaderData;
  return (
    <AppShell userEmail={user?.email}>
      <div className="mx-auto max-w-md py-10">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Choose a workspace</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            You belong to more than one workspace. Pick the one to work in.
          </p>
        </div>
        <div className="space-y-3">
          {workspaces.map((ws) => {
            const isCurrent = ws.id === currentOrgId;
            return (
              <Card key={ws.id} className="transition-colors hover:border-ring/60">
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 truncate text-base">
                    {ws.name}
                    {isCurrent && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                        <Check className="size-3" aria-hidden />
                        Current
                      </span>
                    )}
                  </CardTitle>
                  <CardDescription className="font-mono text-xs">{ws.id}</CardDescription>
                </CardHeader>
                <CardContent>
                  <Form method="post">
                    <input type="hidden" name="orgId" value={ws.id} />
                    <input type="hidden" name="returnTo" value={returnTo} />
                    <Button
                      type="submit"
                      className="w-full"
                      variant={isCurrent ? "secondary" : "default"}
                    >
                      {isCurrent ? "Continue" : "Enter workspace"}
                    </Button>
                  </Form>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>
    </AppShell>
  );
}
