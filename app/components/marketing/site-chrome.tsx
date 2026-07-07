/**
 * Shared marketing chrome — the header and footer used by the home page and the
 * case-study pages so navigation stays consistent. Uses the same `eden-*` tokens
 * and Suisse type as the rest of the landing site, so it themes with the toggle.
 */
import { Link, useRouteLoaderData } from "react-router";
import type { loader as rootLoader } from "~/root";
import { ThemeToggle } from "~/components/theme-toggle";
import { Logo, EdenMark } from "~/components/marketing/logo";

/** The public source repository. Eden is open source; every marketing page links here. */
export const REPO_URL = "https://github.com/zero8ai/eden";

export function SiteHeader() {
  // The root loader runs authkitLoader, so the WorkOS session is available app-wide.
  // When the visitor is already signed in, offer a Dashboard link instead of Sign in.
  const rootData = useRouteLoaderData<typeof rootLoader>("root");
  const isSignedIn = Boolean(rootData?.user);

  return (
    <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
      <Link to="/" aria-label="Eden home">
        <Logo />
      </Link>
      <nav className="flex items-center gap-5 text-sm">
        <Link
          to="/case-studies"
          className="hidden underline-offset-4 hover:underline sm:inline"
        >
          Case studies
        </Link>
        <a
          href={REPO_URL}
          className="hidden underline-offset-4 hover:underline sm:inline"
        >
          GitHub
        </a>
        <ThemeToggle />
        <Link
          to={isSignedIn ? "/dashboard" : "/login"}
          className="rounded-full border border-eden-fg px-4 py-1.5 transition hover:bg-eden-fg hover:text-eden-bg"
        >
          {isSignedIn ? "Dashboard" : "Sign in"}
        </Link>
      </nav>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-10 text-sm text-eden-faint">
      <span className="inline-flex items-center gap-2">
        <EdenMark className="h-4 w-4 text-primary" />
        Eden · open source · self-host or let us run it
      </span>
      <div className="flex items-center gap-5">
        <Link to="/case-studies" className="underline-offset-4 hover:underline">
          Case studies
        </Link>
        <a href={REPO_URL} className="underline-offset-4 hover:underline">
          github.com/zero8ai/eden
        </a>
      </div>
    </footer>
  );
}
