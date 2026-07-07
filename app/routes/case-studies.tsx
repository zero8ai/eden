import type { Route } from "./+types/case-studies";
import { Link } from "react-router";
import { authkitLoader } from "@workos-inc/authkit-react-router";
import type { LoaderFunctionArgs } from "react-router";

import { SiteHeader, SiteFooter } from "~/components/marketing/site-chrome";
import { Reveal, Parallax } from "~/components/landing-motion";
import { caseStudies } from "~/lib/case-studies";
import { pageMeta } from "~/lib/seo";

export const loader = (args: LoaderFunctionArgs) => authkitLoader(args);

export function meta({}: Route.MetaArgs) {
  return pageMeta({
    title: "Case studies — eden",
    description:
      "How teams give their people better tools instead of fewer people — agencies, law firms, support teams and more building agents with eden.",
    path: "/case-studies",
  });
}

/**
 * Case-studies index. Editorial cards, one per vertical, each linking to a full
 * write-up. Same tokens/motion as the home page.
 */
export default function CaseStudies({}: Route.ComponentProps) {
  return (
    <main className="min-h-screen bg-eden-bg font-suisse text-eden-fg">
      <SiteHeader />

      {/* ————— Hero ————— */}
      <section className="mx-auto max-w-6xl px-6 pb-16 pt-16 sm:pt-24">
        <Reveal
          as="p"
          className="text-sm uppercase tracking-[0.25em] text-eden-faint"
        >
          Case studies
        </Reveal>
        <Reveal
          as="h1"
          delay={90}
          className="mt-6 max-w-4xl text-5xl font-medium leading-[1.05] tracking-[-0.02em] sm:text-7xl"
        >
          Same people.
          <span className="italic"> Better tools.</span>
        </Reveal>
        <Reveal
          as="p"
          delay={180}
          className="mt-8 max-w-2xl text-lg leading-relaxed text-eden-muted"
        >
          None of these teams got smaller. They handed the repetitive work to
          agents they built themselves and spent the time they got back on the
          part of the job that needs a human. Here&rsquo;s how it went.
        </Reveal>
      </section>

      <hr className="mx-auto max-w-6xl border-eden-line" />

      {/* ————— Cards ————— */}
      <section className="mx-auto max-w-6xl px-6 py-16 sm:py-20">
        <div className="grid gap-12 sm:gap-16">
          {caseStudies.map((cs, i) => (
            <Reveal key={cs.slug} delay={(i % 2) * 80}>
              <Link
                to={`/case-studies/${cs.slug}`}
                className="group grid gap-8 sm:grid-cols-2 sm:items-center sm:gap-12"
              >
                <div
                  className={`overflow-hidden rounded-xl border border-eden-line ${
                    i % 2 === 1 ? "sm:order-2" : ""
                  }`}
                >
                  <Parallax speed={0.06}>
                    <img
                      src={cs.image}
                      alt={cs.imageAlt}
                      loading="lazy"
                      className="marketing-photo aspect-[4/3] w-full object-cover transition duration-700 group-hover:scale-[1.03]"
                    />
                  </Parallax>
                </div>
                <div>
                  <p className="text-sm uppercase tracking-[0.25em] text-eden-faint">
                    {cs.industry} · {cs.company}
                  </p>
                  <h2 className="mt-4 text-3xl font-medium leading-tight tracking-[-0.01em] sm:text-4xl">
                    {cs.headline}
                  </h2>
                  <p className="mt-4 text-lg leading-relaxed text-eden-muted">
                    {cs.dek}
                  </p>
                  <div className="mt-6 flex items-baseline gap-3">
                    <span className="text-2xl font-medium">
                      {cs.highlight.value}
                    </span>
                    <span className="text-sm text-eden-faint">
                      {cs.highlight.label}
                    </span>
                  </div>
                  <span className="mt-6 inline-block text-sm font-medium underline underline-offset-8 group-hover:opacity-70">
                    Read the story →
                  </span>
                </div>
              </Link>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ————— CTA band ————— */}
      <section className="bg-eden-band-bg text-eden-band-fg">
        <div className="mx-auto max-w-6xl px-6 py-20 text-center sm:py-24">
          <Reveal
            as="h2"
            className="mx-auto max-w-3xl text-4xl font-medium leading-tight tracking-[-0.02em] sm:text-6xl"
          >
            Your team,
            <span className="italic"> doing more of the good part.</span>
          </Reveal>
          <Reveal
            as="p"
            delay={90}
            className="mx-auto mt-6 max-w-xl text-lg leading-relaxed text-eden-band-muted"
          >
            Pick the process everyone dreads, describe it, and let an agent take
            the grind. Your people keep the judgment.
          </Reveal>
          <Reveal delay={180} className="mt-10">
            <Link
              to="/signup"
              className="rounded-full bg-eden-band-fg px-8 py-3 text-lg font-medium text-eden-band-bg transition hover:opacity-85"
            >
              Sign up
            </Link>
          </Reveal>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
