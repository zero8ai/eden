import { useEffect, useRef, useState, type FormEvent } from "react";
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
import type { Route } from "./+types/login";

export async function loader({ request }: Route.LoaderArgs) {
  const returnTo = safeReturnTo(
    new URL(request.url).searchParams.get("returnTo"),
  );
  const session = await getSessionAuth(request);
  if (session.user) throw redirect(returnTo);
  return { returnTo };
}

export function meta() {
  return [{ title: "Sign in · eden" }, ...noindexMeta];
}

export default function Login({ loaderData }: Route.ComponentProps) {
  // Two screens, one route: the email step never touches the server, so advancing
  // reveals nothing about whether an account exists.
  const [step, setStep] = useState<"email" | "password">("email");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (step === "password") passwordRef.current?.focus();
    else emailRef.current?.focus();
  }, [step]);

  function continueToPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setEmail(
      String(form.get("email") ?? "")
        .trim()
        .toLowerCase(),
    );
    setError(null);
    setStep("password");
  }

  function changeEmail() {
    setError(null);
    setStep("email");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const form = new FormData(event.currentTarget);
    try {
      const result = await authClient.signIn.email({
        email,
        password: String(form.get("password") ?? ""),
      });
      if (result.error) {
        setError(result.error.message || "Could not sign in.");
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
            <CardTitle>Sign in</CardTitle>
            <CardDescription>
              {step === "email"
                ? "Continue to your Eden workspace."
                : "Enter your password."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {step === "email" ? (
              <Form
                method="post"
                onSubmit={continueToPassword}
                className="space-y-4"
              >
                <div className="space-y-1.5">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    ref={emailRef}
                    id="email"
                    name="email"
                    type="email"
                    autoComplete="email"
                    defaultValue={email}
                    required
                  />
                </div>
                <Button type="submit" className="w-full">
                  Continue
                </Button>
              </Form>
            ) : (
              <Form method="post" onSubmit={submit} className="space-y-4">
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span
                    className="truncate text-muted-foreground"
                    title={email}
                  >
                    {email}
                  </span>
                  <button
                    type="button"
                    onClick={changeEmail}
                    className="shrink-0 font-medium text-foreground underline underline-offset-4"
                  >
                    Change email
                  </button>
                </div>
                {/* Hidden username field so password managers pair the saved login. */}
                <input
                  type="email"
                  name="email"
                  autoComplete="username"
                  value={email}
                  readOnly
                  hidden
                  tabIndex={-1}
                />
                <div className="space-y-1.5">
                  <Label htmlFor="password">Password</Label>
                  <Input
                    ref={passwordRef}
                    id="password"
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    required
                  />
                </div>
                {error && (
                  <p role="alert" className="text-sm text-destructive">
                    {error}
                  </p>
                )}
                <Button type="submit" className="w-full" disabled={pending}>
                  {pending ? "Signing in…" : "Sign in"}
                </Button>
                <p className="text-center text-sm">
                  <Link
                    to={`/forgot-password?returnTo=${encodeURIComponent(loaderData.returnTo)}${email ? `&email=${encodeURIComponent(email)}` : ""}`}
                    className="text-muted-foreground underline underline-offset-4 hover:text-foreground"
                  >
                    Forgot password?
                  </Link>
                </p>
              </Form>
            )}
            <p className="mt-5 text-center text-sm text-muted-foreground">
              New to Eden?{" "}
              <Link
                to={`/signup?returnTo=${encodeURIComponent(loaderData.returnTo)}`}
                className="font-medium text-foreground underline underline-offset-4"
              >
                Create an account
              </Link>
            </p>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
