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
import type { Route } from "./+types/signup";

export async function loader(args: Route.LoaderArgs) {
  const { request } = args;
  const returnTo = safeReturnTo(
    new URL(request.url).searchParams.get("returnTo"),
  );
  const session = await getSessionAuth(args);
  if (session.user) throw redirect(returnTo);
  return { returnTo };
}

export function meta() {
  return [{ title: "Create an account · eden" }, ...noindexMeta];
}

export default function Signup({ loaderData }: Route.ComponentProps) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const form = new FormData(event.currentTarget);
    try {
      const result = await authClient.signUp.email({
        name: String(form.get("name") ?? "").trim(),
        email: String(form.get("email") ?? "")
          .trim()
          .toLowerCase(),
        password: String(form.get("password") ?? ""),
      });
      if (result.error) {
        setError(result.error.message || "Could not create the account.");
        setPending(false);
        return;
      }
    } catch {
      setError("Something went wrong. Please try again.");
      setPending(false);
      return;
    }
    window.location.assign(loaderData.returnTo);
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-eden-bg px-6 py-12 text-eden-fg">
      <div className="w-full max-w-sm space-y-8">
        <Link to="/" className="mx-auto block w-fit" aria-label="eden home">
          <Logo className="h-8" />
        </Link>
        <Card>
          <CardHeader>
            <CardTitle>Create an account</CardTitle>
            <CardDescription>
              Start with a personal workspace. You can join others later.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Form method="post" onSubmit={submit} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="name">Name</Label>
                <Input id="name" name="name" autoComplete="name" required />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  name="password"
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
                {pending ? "Creating account…" : "Create account"}
              </Button>
            </Form>
            <p className="mt-5 text-center text-sm text-muted-foreground">
              Already have an account?{" "}
              <Link
                to={`/login?returnTo=${encodeURIComponent(loaderData.returnTo)}`}
                className="font-medium text-foreground underline underline-offset-4"
              >
                Sign in
              </Link>
            </p>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
