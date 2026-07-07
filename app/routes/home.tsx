import type { Route } from "./+types/home";
import { Link, Form } from "react-router";
import { signOut, authkitLoader } from "@workos-inc/authkit-react-router";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import {
  GitPullRequest,
  Plug,
  Rocket,
  Sparkles,
  Sprout,
  type LucideIcon,
} from "lucide-react";

import { accentChip, type Accent } from "~/components/shell";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { cn } from "~/lib/utils";

export const loader = (args: LoaderFunctionArgs) => authkitLoader(args);

export async function action({ request }: ActionFunctionArgs) {
  return await signOut(request);
}

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Eden" },
    {
      name: "description",
      content: "Build, manage, and deploy eve agents from the web.",
    },
  ];
}

// The four product pillars from PRD.md §6. These are placeholders for M0 —
// each will become its own route/section as the milestones land. Each carries a
// distinct signature icon + accent so the pillars read as a colored set.
const pillars: {
  key: string;
  title: string;
  blurb: string;
  milestone: string;
  icon: LucideIcon;
  accent: Accent;
}[] = [
  {
    key: "connect",
    title: "Connect",
    blurb:
      "GitHub App: create a new eve repo or connect an existing one, run init, parse the agent.",
    milestone: "M0–M1",
    icon: Plug,
    accent: "brand",
  },
  {
    key: "author",
    title: "Author",
    blurb:
      "Visual editors for every eve concept, plus a Pi-based assistant that writes tool code for you.",
    milestone: "M1",
    icon: Sparkles,
    accent: "sky",
  },
  {
    key: "review",
    title: "Review & version",
    blurb:
      "Git-native: every change is a branch → pull request → merge. The repo stays the source of truth.",
    milestone: "M1",
    icon: GitPullRequest,
    accent: "amber",
  },
  {
    key: "deploy",
    title: "Deploy & operate",
    blurb:
      "One-click deploy via the DeployTarget seam. Managed hosting, metering, and billing on top.",
    milestone: "M2–M3",
    icon: Rocket,
    accent: "emerald",
  },
];

export default function Home({ loaderData }: Route.ComponentProps) {
  const { user } = loaderData;

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="border-b">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4 sm:px-6">
          <span className="flex items-center gap-1.5">
            <span className="flex size-6 items-center justify-center rounded-md bg-primary/10 text-primary ring-1 ring-primary/20">
              <Sprout className="size-3.5" aria-hidden />
            </span>
            <span className="text-base font-semibold tracking-tight">Eden</span>
          </span>
          <div className="flex items-center gap-3">
            {user ? (
              <>
                <span className="hidden text-sm text-muted-foreground sm:inline">
                  {user.email}
                </span>
                <Button asChild size="sm">
                  <Link to="/dashboard">Dashboard</Link>
                </Button>
                <Form method="post">
                  <Button variant="ghost" size="sm" type="submit">
                    Sign out
                  </Button>
                </Form>
              </>
            ) : (
              <>
                <Button variant="ghost" size="sm" asChild>
                  <Link to="/login">Sign in</Link>
                </Button>
                <Button size="sm" asChild>
                  <Link to="/signup">Sign up</Link>
                </Button>
              </>
            )}
          </div>
        </div>
      </header>

      <section className="mx-auto flex max-w-3xl flex-col items-center px-4 py-24 text-center sm:px-6">
        <Badge
          variant="secondary"
          className="gap-1.5 border-primary/20 bg-primary/10 text-primary"
        >
          <Sprout className="size-3.5" aria-hidden />
          Build, manage, and deploy eve agents
        </Badge>
        <h1 className="mt-6 text-4xl font-semibold tracking-tight sm:text-5xl">
          Build, manage, and deploy eve agents from the web.
        </h1>
        <p className="mt-6 max-w-2xl text-lg text-muted-foreground">
          Eden is a web app over Vercel&rsquo;s{" "}
          <a
            className="underline underline-offset-4"
            href="https://github.com/vercel/eve"
          >
            eve
          </a>{" "}
          framework, so product managers can create agents — instructions,
          tools, skills, schedules, channels — and ship them without writing
          code by hand.
        </p>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          {user ? (
            <>
              <Button asChild size="lg">
                <Link to="/dashboard">Open dashboard</Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                <Link to="/connect">Connect a repo</Link>
              </Button>
            </>
          ) : (
            <>
              <Button asChild size="lg">
                <Link to="/signup">Get started</Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                <Link to="/login">Sign in</Link>
              </Button>
            </>
          )}
        </div>
      </section>

      <div className="mx-auto max-w-5xl px-4 pb-24 sm:px-6">
        <div className="grid gap-4 sm:grid-cols-2">
          {pillars.map((p) => {
            const Icon = p.icon;
            return (
              <Card key={p.key} className="transition-colors hover:border-ring/60">
                <CardHeader>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2.5">
                      <span
                        className={cn(
                          "flex size-9 shrink-0 items-center justify-center rounded-xl",
                          accentChip[p.accent],
                        )}
                      >
                        <Icon className="size-5" aria-hidden />
                      </span>
                      <CardTitle className="text-lg">{p.title}</CardTitle>
                    </div>
                    <span className="text-xs font-medium text-muted-foreground">
                      {p.milestone}
                    </span>
                  </div>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground">{p.blurb}</p>
                </CardContent>
              </Card>
            );
          })}
        </div>

        <p className="mt-12 text-sm text-muted-foreground">
          M0 skeleton · React Router 7 + Vite. Next: WorkOS AuthKit
          (<code>npx workos@latest install</code>) and the org/project model.
          See{" "}
          <Link className="underline underline-offset-4" to="/">
            PRD.md
          </Link>{" "}
          and ARCHITECTURE.md.
        </p>
      </div>
    </main>
  );
}
