/**
 * Workspace members + invitations (issue #56). Everyone in a workspace is equal — any member
 * can invite anyone else and rename the workspace; there are no roles or permission checks here
 * (out of scope by decision). Invitations are delegated end-to-end to WorkOS: `sendInvitation`
 * emails the invitee and hosts the accept page, which lands on our `/callback` → dashboard →
 * the existing adopt-membership path. Eden stores NO invitation state; this page reads live from
 * WorkOS every load.
 */
import { authkitLoader, getWorkOS, withAuth } from "@workos-inc/authkit-react-router";
import { eq } from "drizzle-orm";
import { Building2, MailPlus, Users } from "lucide-react";
import {
  Form,
  redirect,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { AppShell, PageHeader, accentText } from "~/components/shell";
import { Badge } from "~/components/ui/badge";
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
import { db } from "~/db/client.server";
import { orgs } from "~/db/schema";
import { recordAudit } from "~/managed/audit.server";
import { noindexMeta } from "~/lib/seo";
import type { Route } from "./+types/org.members";

interface Member {
  id: string;
  email: string;
  name: string | null;
}
interface PendingInvite {
  id: string;
  email: string;
  expiresAt: string;
}
interface MembersView {
  org: Org | null;
  members: Member[];
  pendingInvites: PendingInvite[];
  currentUserId: string;
}

export const loader = (args: LoaderFunctionArgs) =>
  authkitLoader(
    args,
    async ({ auth }): Promise<MembersView> => {
      // Close the org-less hole for this page too: provision/adopt/choose before we sync.
      await ensureWorkspace(args.request, auth);
      const { org } = await syncTenant(auth);
      if (!org) {
        return { org: null, members: [], pendingInvites: [], currentUserId: auth.user.id };
      }
      const workos = getWorkOS();
      const [users, invitations] = await Promise.all([
        workos.userManagement.listUsers({ organizationId: org.id }),
        workos.userManagement.listInvitations({ organizationId: org.id }),
      ]);
      const members: Member[] = users.data.map((u) => ({
        id: u.id,
        email: u.email,
        name: [u.firstName, u.lastName].filter(Boolean).join(" ") || null,
      }));
      const pendingInvites: PendingInvite[] = invitations.data
        .filter((i) => i.state === "pending")
        .map((i) => ({ id: i.id, email: i.email, expiresAt: i.expiresAt }));
      return { org, members, pendingInvites, currentUserId: auth.user.id };
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
  if (!org) return { error: "No workspace." };

  const workos = getWorkOS();
  const form = await args.request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "invite") {
    const email = String(form.get("email") ?? "").trim().toLowerCase();
    if (!email || !email.includes("@")) {
      return { error: "Enter a valid email address." };
    }
    try {
      try {
        await workos.userManagement.sendInvitation({
          email,
          organizationId: org.id,
          inviterUserId: auth.user.id,
          roleSlug: "admin",
        });
      } catch {
        // Environment has no "admin" role — invite with the default role instead.
        await workos.userManagement.sendInvitation({
          email,
          organizationId: org.id,
          inviterUserId: auth.user.id,
        });
      }
    } catch (error) {
      // Already a member, already invited, domain restriction, … — surface, don't crash.
      return { error: error instanceof Error ? error.message : "Could not send the invitation." };
    }
    await recordAudit({
      orgId: org.id,
      actorUserId: auth.user.id,
      action: "member_invited",
      target: email,
    });
    throw redirect("/org/members");
  }

  if (intent === "revoke-invite") {
    const id = String(form.get("invitationId") ?? "");
    const email = String(form.get("email") ?? "") || null;
    if (id) {
      await workos.userManagement.revokeInvitation(id);
      await recordAudit({
        orgId: org.id,
        actorUserId: auth.user.id,
        action: "invite_revoked",
        target: email ?? id,
      });
    }
    throw redirect("/org/members");
  }

  if (intent === "resend-invite") {
    const id = String(form.get("invitationId") ?? "");
    if (id) await workos.userManagement.resendInvitation(id);
    throw redirect("/org/members");
  }

  if (intent === "rename-workspace") {
    const name = String(form.get("name") ?? "").trim();
    if (!name) return { error: "Enter a workspace name." };
    await workos.organizations.updateOrganization({ organization: org.id, name });
    // Keep the mirror in step so the shell/switcher show the new name without a WorkOS round-trip.
    await db.update(orgs).set({ name }).where(eq(orgs.id, org.id));
    await recordAudit({
      orgId: org.id,
      actorUserId: auth.user.id,
      action: "workspace_renamed",
      meta: { name },
    });
    throw redirect("/org/members");
  }

  return { error: "Unknown action." };
}

export function meta() {
  return [{ title: "Members · eden" }, ...noindexMeta];
}

export default function Members({ loaderData, actionData }: Route.ComponentProps) {
  const { user, org, members, pendingInvites, currentUserId } = loaderData;
  const error = actionData?.error;

  if (!org) {
    return (
      <AppShell userEmail={user?.email}>
        <PageHeader title="Members" description="You're not scoped to a workspace." />
      </AppShell>
    );
  }

  return (
    <AppShell userEmail={user?.email}>
      <PageHeader
        title="Members"
        description="Everyone in a workspace can do everything, including inviting others."
      />

      <div className="space-y-6">
        {/* Workspace name + rename */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Building2 className={`size-4 ${accentText.indigo}`} aria-hidden />
              Workspace
            </CardTitle>
            <CardDescription>
              The workspace name is shown to everyone you invite. Auto-created names read
              oddly once shared — rename it to something the team recognizes.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Form method="post" className="flex max-w-xl items-end gap-2">
              <input type="hidden" name="intent" value="rename-workspace" />
              <div className="flex-1 space-y-1.5">
                <Label htmlFor="name">Workspace name</Label>
                <Input id="name" name="name" defaultValue={org.name} autoComplete="off" />
              </div>
              <Button type="submit">Save</Button>
            </Form>
          </CardContent>
        </Card>

        {/* Invite */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MailPlus className={`size-4 ${accentText.emerald}`} aria-hidden />
              Invite a teammate
            </CardTitle>
            <CardDescription>
              They get an email from WorkOS with a link to join this workspace. The link is
              valid for 7 days.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Form method="post" className="flex max-w-xl items-end gap-2">
              <input type="hidden" name="intent" value="invite" />
              <div className="flex-1 space-y-1.5">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  placeholder="teammate@company.com"
                  autoComplete="off"
                />
              </div>
              <Button type="submit">Send invite</Button>
            </Form>
            {error && <p className="mt-2 text-sm text-rose-600 dark:text-rose-400">{error}</p>}
          </CardContent>
        </Card>

        {/* Members */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className={`size-4 ${accentText.brand}`} aria-hidden />
              Members
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y rounded-lg border text-sm">
              {members.map((m) => (
                <li key={m.id} className="flex items-center justify-between px-4 py-2">
                  <span className="min-w-0">
                    {m.name && <span className="font-medium">{m.name} </span>}
                    <span className="text-muted-foreground">{m.email}</span>
                  </span>
                  {m.id === currentUserId && <Badge variant="secondary">you</Badge>}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        {/* Pending invitations */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MailPlus className={`size-4 ${accentText.amber}`} aria-hidden />
              Pending invitations
            </CardTitle>
          </CardHeader>
          <CardContent>
            {pendingInvites.length === 0 ? (
              <p className="text-sm text-muted-foreground">No pending invitations.</p>
            ) : (
              <ul className="divide-y rounded-lg border text-sm">
                {pendingInvites.map((inv) => (
                  <li
                    key={inv.id}
                    className="flex flex-wrap items-center justify-between gap-2 px-4 py-2"
                  >
                    <span className="min-w-0">
                      <span className="font-medium">{inv.email}</span>
                      <span className="ml-2 text-muted-foreground">
                        expires {new Date(inv.expiresAt).toLocaleDateString()}
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
                      <Form method="post">
                        <input type="hidden" name="intent" value="resend-invite" />
                        <input type="hidden" name="invitationId" value={inv.id} />
                        <Button type="submit" variant="outline" size="sm">
                          Resend
                        </Button>
                      </Form>
                      <Form method="post">
                        <input type="hidden" name="intent" value="revoke-invite" />
                        <input type="hidden" name="invitationId" value={inv.id} />
                        <input type="hidden" name="email" value={inv.email} />
                        <Button type="submit" variant="ghost" size="sm">
                          Revoke
                        </Button>
                      </Form>
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
