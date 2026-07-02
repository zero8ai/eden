import {
  authkitLoader,
  signOut,
} from "@workos-inc/authkit-react-router";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
} from "react-router";
import { Form, Link } from "react-router";

import { listProjects } from "~/db/queries.server";
import { syncTenant } from "~/auth/tenant.server";
import type { Route } from "./+types/dashboard";

// `ensureSignedIn: true` redirects anonymous visitors to WorkOS sign-in. The inner
// loader only runs for authenticated users, so `auth` is always populated here.
export const loader = (args: LoaderFunctionArgs) =>
  authkitLoader(
    args,
    async ({ auth }) => {
      const { org } = await syncTenant(auth);
      const projects = org ? await listProjects(org.id) : [];
      return { org, projects };
    },
    { ensureSignedIn: true },
  );

export async function action({ request }: ActionFunctionArgs) {
  return await signOut(request);
}

export function meta() {
  return [{ title: "Dashboard · Eden" }];
}

export default function Dashboard({ loaderData }: Route.ComponentProps) {
  const { user, org, projects } = loaderData;

  return (
    <main className="min-h-screen px-6 py-12 text-gray-900 dark:text-gray-100">
      <div className="mx-auto max-w-4xl">
        <header className="flex items-center justify-between">
          <div>
            <Link
              to="/"
              className="text-sm font-medium uppercase tracking-widest text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"
            >
              Eden
            </Link>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">
              {org ? org.name : "Your workspace"}
            </h1>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-sm text-gray-600 dark:text-gray-300">
              {user.email}
            </span>
            {org && (
              <Link
                to="/org/settings"
                className="text-sm font-medium text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white"
              >
                Settings
              </Link>
            )}
            <Form method="post">
              <button
                type="submit"
                className="rounded-md bg-gray-200 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
              >
                Sign out
              </button>
            </Form>
          </div>
        </header>

        {!org && (
          <p className="mt-8 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-200">
            You&rsquo;re signed in but not scoped to an organization yet. Eden
            uses a WorkOS Organization as a tenant &mdash; once you belong to
            one, your projects show up here.
          </p>
        )}

        <section className="mt-10">
          <div className="flex items-baseline justify-between">
            <h2 className="text-lg font-semibold">Projects</h2>
            <div className="flex items-center gap-4">
              <span className="text-xs font-medium text-gray-400">
                {projects.length} total
              </span>
              {org && (
                <Link
                  to="/connect"
                  className="rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
                >
                  Connect a repo
                </Link>
              )}
            </div>
          </div>

          {projects.length === 0 ? (
            <div className="mt-4 rounded-xl border border-dashed border-gray-300 p-8 text-center dark:border-gray-700">
              <p className="text-sm text-gray-600 dark:text-gray-300">
                No projects yet.{" "}
                {org ? (
                  <>
                    <Link
                      to="/connect"
                      className="underline underline-offset-4"
                    >
                      Connect an eve repo
                    </Link>{" "}
                    to get started.
                  </>
                ) : (
                  "Join an organization to connect a repo."
                )}
              </p>
            </div>
          ) : (
            <ul className="mt-4 grid gap-3 sm:grid-cols-2">
              {projects.map((p) => (
                <li key={p.id}>
                  <Link
                    to={`/projects/${p.id}`}
                    className="block rounded-xl border border-gray-200 p-4 hover:border-gray-400 dark:border-gray-800 dark:hover:border-gray-600"
                  >
                    <div className="font-medium">{p.name}</div>
                    <div className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                      {p.repoOwner && p.repoName
                        ? `${p.repoOwner}/${p.repoName}`
                        : "no repo connected"}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
