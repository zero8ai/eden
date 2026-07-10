import { Form, Link, redirect } from "react-router";

import { requireSession, sessionLoader } from "~/auth/session.server";
import { AppShell, PageHeader } from "~/components/shell";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { noindexMeta } from "~/lib/seo";
import { auth } from "~/lib/auth.server";
import type { Route } from "./+types/accept-invitation.$invitationId";

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "This invitation is invalid or no longer available.";
}

export const loader = (args: Route.LoaderArgs) =>
  sessionLoader(
    args,
    async ({ auth: session }) => {
      const invitationId = args.params.invitationId;
      if (!invitationId)
        return { invitation: null, error: "Invitation not found." };
      try {
        const invitation = await auth.api.getInvitation({
          query: { id: invitationId },
          headers: session.requestHeaders,
        });
        return { invitation, error: null };
      } catch (error) {
        return { invitation: null, error: errorMessage(error) };
      }
    },
    { ensureSignedIn: true },
  );

export async function action(args: Route.ActionArgs) {
  const session = await requireSession(args);
  const form = await args.request.formData();
  const invitationId = String(form.get("invitationId") ?? "");
  try {
    await auth.api.acceptInvitation({
      body: { invitationId },
      headers: session.requestHeaders,
    });
  } catch (error) {
    return { error: errorMessage(error) };
  }
  throw redirect("/dashboard");
}

export function meta() {
  return [{ title: "Accept invitation · eden" }, ...noindexMeta];
}

export default function AcceptInvitation({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const error = actionData?.error ?? loaderData.error;
  const invitation = loaderData.invitation;

  return (
    <AppShell userEmail={loaderData.user.email}>
      <PageHeader
        title="Workspace invitation"
        description="Review and accept your invitation."
      />
      <Card className="mx-auto max-w-lg">
        <CardHeader>
          <CardTitle>
            {invitation
              ? `Join ${invitation.organizationName}`
              : "Invitation unavailable"}
          </CardTitle>
          <CardDescription>
            {invitation
              ? `${invitation.inviterEmail} invited ${loaderData.user.email} to this workspace.`
              : "The invitation could not be opened for this account."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {error ? (
            <div className="space-y-4">
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
              <Button asChild variant="outline">
                <Link to="/dashboard">Back to dashboard</Link>
              </Button>
            </div>
          ) : invitation ? (
            <Form method="post">
              <input type="hidden" name="invitationId" value={invitation.id} />
              <Button type="submit">Accept invitation</Button>
            </Form>
          ) : null}
        </CardContent>
      </Card>
    </AppShell>
  );
}
