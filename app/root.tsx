import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  type LoaderFunctionArgs,
} from "react-router";
import { authkitLoader } from "@workos-inc/authkit-react-router";

import { ensureSplitterStarted } from "~/deploy/splitter.server";
import { ensureWorkerStarted } from "~/jobs/worker.server";
import type { Route } from "./+types/root";
import "./app.css";

export const loader = (args: LoaderFunctionArgs) => {
  // Boot the background singletons with the first server render (per-process guards).
  ensureWorkerStarted();
  ensureSplitterStarted();
  return authkitLoader(args);
};

/**
 * Resolve the `.dark` class before first paint (no FOUC). Preference order:
 *   explicit cookie ("light"/"dark") wins; otherwise follow the OS. The OS
 *   listener only steers the theme while in "system" mode. Keep this in sync
 *   with THEME_COOKIE / applyTheme in app/components/theme-toggle.tsx.
 */
const darkModeScript = `
(function () {
  var mql = window.matchMedia("(prefers-color-scheme: dark)");
  var read = function () {
    var m = document.cookie.match(/(?:^|; )eden-theme=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : "system";
  };
  var apply = function () {
    var pref = read();
    var dark = pref === "dark" || (pref !== "light" && mql.matches);
    document.documentElement.classList.toggle("dark", dark);
  };
  apply();
  mql.addEventListener("change", function () {
    if (read() === "system") apply();
  });
})();
`;

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <script dangerouslySetInnerHTML={{ __html: darkModeScript }} />
        <Meta />
        <Links />
      </head>
      <body className="min-h-screen antialiased">
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "Oops!";
  let details = "An unexpected error occurred.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "404" : "Error";
    details =
      error.status === 404
        ? "The requested page could not be found."
        : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-3 px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">{message}</h1>
      <p className="text-muted-foreground">{details}</p>
      {stack && (
        <pre className="mt-4 overflow-x-auto rounded-lg border bg-muted p-4 text-xs">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  );
}
