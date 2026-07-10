import { useState, type FormEvent } from "react";
import { Form, Link } from "react-router";

import { safeReturnTo } from "~/auth/return-to";
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
import type { Route } from "./+types/reset-password";

// Prefill only values that look like an email; anything else is dropped.
function safePrefillEmail(value: string | null): string {
  const email = (value ?? "").trim().toLowerCase().slice(0, 254);
  return /^[^\s@]+@[^\s@]+$/.test(email) ? email : "";
}

export async function loader({ request }: Route.LoaderArgs) {
  // Better Auth links here with ?token=…; expired/invalid links arrive as ?error=….
  // returnTo and email were planted in the redirectTo by /forgot-password.
  const url = new URL(request.url);
  const token = url.searchParams.get("error")
    ? null
    : url.searchParams.get("token");
  const returnTo = safeReturnTo(url.searchParams.get("returnTo"));
  const email = safePrefillEmail(url.searchParams.get("email"));
  return { token, returnTo, email };
}

export function meta() {
  return [{ title: "Reset password · eden" }, ...noindexMeta];
}

export default function ResetPassword({ loaderData }: Route.ComponentProps) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const form = new FormData(event.currentTarget);
    const newPassword = String(form.get("newPassword") ?? "");
    const confirmation = String(form.get("passwordConfirmation") ?? "");
    if (newPassword.length < 8 || newPassword.length > 128) {
      setError("Password must be between 8 and 128 characters.");
      return;
    }
    if (newPassword !== confirmation) {
      setError("Passwords do not match.");
      return;
    }
    setPending(true);
    try {
      const result = await authClient.resetPassword({
        newPassword,
        token: loaderData.token ?? "",
      });
      if (result.error) {
        setError(result.error.message || "Could not reset the password.");
        setPending(false);
        return;
      }
    } catch {
      setError("Something went wrong. Please try again.");
      setPending(false);
      return;
    }
    setDone(true);
  }

  // The reset token never travels on these links — only the sanitized returnTo
  // (and the email, so a fresh request doesn't make the user retype it).
  const loginHref = `/login?returnTo=${encodeURIComponent(loaderData.returnTo)}`;
  const forgotHref = `/forgot-password?returnTo=${encodeURIComponent(loaderData.returnTo)}${loaderData.email ? `&email=${encodeURIComponent(loaderData.email)}` : ""}`;

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
              {done
                ? "Your password has been updated."
                : loaderData.token
                  ? "Choose a new password for your account."
                  : "This link can't be used."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {done ? (
              <div className="space-y-4">
                <p role="status" className="text-sm text-muted-foreground">
                  You can now sign in with your new password.
                </p>
                <Button asChild className="w-full">
                  <Link to={loginHref}>Sign in</Link>
                </Button>
              </div>
            ) : !loaderData.token ? (
              <div className="space-y-4">
                <p role="alert" className="text-sm text-muted-foreground">
                  This password reset link is invalid or has expired. Request a
                  new one and try again.
                </p>
                <Button asChild className="w-full">
                  <Link to={forgotHref}>Request a new link</Link>
                </Button>
                <p className="text-center text-sm text-muted-foreground">
                  <Link
                    to={loginHref}
                    className="font-medium text-foreground underline underline-offset-4"
                  >
                    Back to sign in
                  </Link>
                </p>
              </div>
            ) : (
              <Form method="post" onSubmit={submit} className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="newPassword">New password</Label>
                  <Input
                    id="newPassword"
                    name="newPassword"
                    type="password"
                    minLength={8}
                    maxLength={128}
                    autoComplete="new-password"
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="passwordConfirmation">Confirm password</Label>
                  <Input
                    id="passwordConfirmation"
                    name="passwordConfirmation"
                    type="password"
                    minLength={8}
                    maxLength={128}
                    autoComplete="new-password"
                    required
                  />
                </div>
                {error && (
                  <p role="alert" className="text-sm text-destructive">
                    {error}
                  </p>
                )}
                <Button type="submit" className="w-full" disabled={pending}>
                  {pending ? "Updating…" : "Update password"}
                </Button>
              </Form>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
