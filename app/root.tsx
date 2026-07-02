import {
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
import "./app.css";

export { ErrorBoundary } from "~/components/error-boundary";

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
