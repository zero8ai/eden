import type { Route } from "./+types/home";
import { Link } from "react-router";

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
// each will become its own route/section as the milestones land.
const pillars = [
  {
    key: "connect",
    title: "Connect",
    blurb:
      "GitHub App: create a new eve repo or connect an existing one, run init, parse the agent.",
    milestone: "M0–M1",
  },
  {
    key: "author",
    title: "Author",
    blurb:
      "Visual editors for every eve concept, plus a Pi-based assistant that writes tool code for you.",
    milestone: "M1",
  },
  {
    key: "review",
    title: "Review & version",
    blurb:
      "Git-native: every change is a branch → pull request → merge. The repo stays the source of truth.",
    milestone: "M1",
  },
  {
    key: "deploy",
    title: "Deploy & operate",
    blurb:
      "One-click deploy via the DeployTarget seam. Managed hosting, metering, and billing on top.",
    milestone: "M2–M3",
  },
];

export default function Home() {
  return (
    <main className="min-h-screen px-6 py-16 text-gray-900 dark:text-gray-100">
      <div className="mx-auto max-w-4xl">
        <p className="text-sm font-medium uppercase tracking-widest text-gray-500 dark:text-gray-400">
          Eden
        </p>
        <h1 className="mt-2 text-4xl font-semibold tracking-tight">
          Build, manage, and deploy eve agents from the web.
        </h1>
        <p className="mt-4 max-w-2xl text-lg text-gray-600 dark:text-gray-300">
          A web interface over Vercel&rsquo;s{" "}
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

        <div className="mt-12 grid gap-4 sm:grid-cols-2">
          {pillars.map((p) => (
            <section
              key={p.key}
              className="rounded-xl border border-gray-200 p-5 dark:border-gray-800"
            >
              <div className="flex items-baseline justify-between">
                <h2 className="text-lg font-semibold">{p.title}</h2>
                <span className="text-xs font-medium text-gray-400">
                  {p.milestone}
                </span>
              </div>
              <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
                {p.blurb}
              </p>
            </section>
          ))}
        </div>

        <p className="mt-12 text-sm text-gray-500 dark:text-gray-400">
          M0 skeleton · React Router 7 + Vite. Next: WorkOS AuthKit
          (<code>npx workos@latest install</code>) and the org/project model.
          See <Link className="underline underline-offset-4" to="/">PRD.md</Link>{" "}
          and ARCHITECTURE.md.
        </p>
      </div>
    </main>
  );
}
