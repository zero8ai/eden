import { useState, type FormEvent } from "react";
import { Form, Link, redirect } from "react-router";

import { safeReturnTo } from "~/auth/return-to";
import { getSessionAuth } from "~/auth/session.server";
import { Logo } from "~/components/marketing/logo";
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
import { authClient } from "~/lib/auth-client";
import { noindexMeta } from "~/lib/seo";
import type { Route } from "./+types/forgot-password";

// Prefill only values that look like an email; anything else is dropped.
function safePrefillEmail(value: string | null): string {
  const email = (value ?? "").trim().toLowerCase().slice(0, 254);
  return /^[^\s@]+@[^\s@]+$/.test(email) ? email : "";
}

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const returnTo = safeReturnTo(url.searchParams.get("returnTo"));
  const email = safePrefillEmail(url.searchParams.get("email"));
  const session = await getSessionAuth(request);
  if (session.user) throw redirect(returnTo);
  return { returnTo, email };
}

export function meta() {
  return [{ title: "Forgot password · eden" }, ...noindexMeta];
}

export default function ForgotPassword({ loaderData }: Route.ComponentProps) {
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "")
      .trim()
      .toLowerCase();
    // The emailed link comes back to /reset-password; returnTo (and the email,
    // for the request-a-new-link path) ride along as query params. Better Auth
    // appends its token/error via searchParams, so the query survives.
    const redirectTo = new URL("/reset-password", window.location.origin);
    redirectTo.searchParams.set("returnTo", loaderData.returnTo);
    if (email) redirectTo.searchParams.set("email", email);
    try {
      await authClient.requestPasswordReset({
        email,
        redirectTo: redirectTo.href,
      });
    } catch {
      // Fall through to the neutral copy — the response must not reveal
      // whether an account exists for the address.
    }
    setPending(false);
    setSubmitted(true);
  }

  const loginHref = `/login?returnTo=${encodeURIComponent(loaderData.returnTo)}`;

  return (
    <main className="flex min-h-screen items-center justify-center bg-eden-bg px-6 py-12 text-eden-fg">
      <div className="w-full max-w-sm space-y-8">
        <Link to="/" className="mx-auto block w-fit" aria-label="eden home">
          <Logo className="h-8" />
        </Link>
        <Card>
          <CardHeader>
            <CardTitle>Reset your password</CardTitle>
            <CardDescription>
              {submitted
                ? "Check your email."
                : "Enter your email and we'll send you a reset link."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {submitted ? (
              <p role="status" className="text-sm text-muted-foreground">
                If an account exists for that email, we&apos;ve sent a link to
                reset your password. It may take a minute to arrive.
              </p>
            ) : (
              <Form method="post" onSubmit={submit} className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    name="email"
                    type="email"
                    autoComplete="email"
                    defaultValue={loaderData.email}
                    required
                  />
                </div>
                <Button type="submit" className="w-full" disabled={pending}>
                  {pending ? "Sending…" : "Send reset link"}
                </Button>
              </Form>
            )}
            <p className="mt-5 text-center text-sm text-muted-foreground">
              <Link
                to={loginHref}
                className="font-medium text-foreground underline underline-offset-4"
              >
                Back to sign in
              </Link>
            </p>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
