/**
 * Secrets manager (Author pillar, M1 — PRD §7.2).
 *
 * Per-environment (or project-wide) secrets, stored via the SecretsProvider seam — never in
 * the repo. Values are write-only from the UI: you can set or delete, but the plaintext is
 * never sent back to the browser (only names are listed). Tools/connections reference secrets
 * by name; the value is injected as container env at deploy time.
 */
import { authkitLoader, withAuth } from "@workos-inc/authkit-react-router";
import {
  Form,
  Link,
  redirect,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import {
  listEnvironments,
  type Environment,
  type Project,
} from "~/db/queries.server";
import { requireProject } from "~/project/guard.server";
import { getRuntime } from "~/seams/index.server";
import type { Route } from "./+types/projects.$projectId.secrets";

const ALL = "all";

interface SecretsView {
  project: Project;
  envs: Environment[];
  scope: { environmentId: string | null; label: string };
  names: string[];
  configured: boolean;
  error: string | null;
}

/** Resolve the `?env=` param to an environmentId (null == project-wide), validated. */
function resolveScope(
  raw: string | null,
  envs: Environment[],
): { environmentId: string | null; label: string } {
  if (!raw || raw === ALL) return { environmentId: null, label: "All environments" };
  const env = envs.find((e) => e.id === raw);
  return env
    ? { environmentId: env.id, label: env.name }
    : { environmentId: null, label: "All environments" };
}

export const loader = (args: LoaderFunctionArgs) =>
  authkitLoader(
    args,
    async ({ auth }): Promise<SecretsView> => {
      const project = await requireProject(
        { user: auth.user, organizationId: auth.organizationId, role: auth.role },
        args.params.projectId,
      );
      const envs = await listEnvironments(project.id);
      const scope = resolveScope(
        new URL(args.request.url).searchParams.get("env"),
        envs,
      );

      try {
        const names = await getRuntime().secrets.listNames(
          project.id,
          scope.environmentId,
        );
        return { project, envs, scope, names, configured: true, error: null };
      } catch (error) {
        return {
          project,
          envs,
          scope,
          names: [] as string[],
          configured: false,
          error: (error as Error).message,
        };
      }
    },
    { ensureSignedIn: true },
  );

export async function action(args: ActionFunctionArgs) {
  const auth = await withAuth(args);
  if (!auth.user) throw redirect("/login");
  const project = await requireProject(
    {
      user: auth.user,
      organizationId: auth.organizationId ?? null,
      role: auth.role ?? null,
    },
    args.params.projectId,
  );

  const form = await args.request.formData();
  const intent = String(form.get("intent") ?? "");
  const envRaw = String(form.get("env") ?? ALL);
  const envs = await listEnvironments(project.id);
  const { environmentId } = resolveScope(envRaw, envs);
  const key = String(form.get("key") ?? "").trim();
  const back = `/projects/${project.id}/secrets?env=${encodeURIComponent(envRaw)}`;

  const secrets = getRuntime().secrets;
  try {
    if (intent === "set") {
      const value = String(form.get("value") ?? "");
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        return { error: "Key must be a valid env var name (A–Z, 0–9, _)." };
      }
      if (!value) return { error: "Value is required." };
      await secrets.set({ projectId: project.id, environmentId, key }, value);
    } else if (intent === "delete") {
      await secrets.delete({ projectId: project.id, environmentId, key });
    }
  } catch (error) {
    return { error: (error as Error).message };
  }
  throw redirect(back);
}

export function meta() {
  return [{ title: "Secrets · Eden" }];
}

export default function Secrets({ loaderData, actionData }: Route.ComponentProps) {
  const { project, envs, scope, names, configured, error } = loaderData;
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";
  const envValue = scope.environmentId ?? ALL;

  return (
    <main className="min-h-screen px-6 py-12 text-gray-900 dark:text-gray-100">
      <div className="mx-auto max-w-2xl">
        <Link
          to={`/projects/${project.id}`}
          className="text-sm font-medium uppercase tracking-widest text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"
        >
          ← {project.name}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Secrets</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Stored encrypted, never in the repo. Reference them by name in tools and
          connections; values are injected at deploy time.
        </p>

        {/* Scope selector */}
        <Form method="get" className="mt-6 flex items-center gap-2">
          <label className="text-sm text-gray-600 dark:text-gray-300">Scope</label>
          <select
            name="env"
            defaultValue={envValue}
            className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900"
          >
            <option value={ALL}>All environments</option>
            {envs.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="rounded-md bg-gray-200 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-200"
          >
            Switch
          </button>
        </Form>

        {!configured && (
          <div className="mt-6 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-200">
            <p className="font-medium">Secrets store not configured.</p>
            <p className="mt-1 opacity-80">{error}</p>
          </div>
        )}
        {actionData?.error && (
          <p className="mt-6 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-800/60 dark:bg-red-950/40 dark:text-red-200">
            {actionData.error}
          </p>
        )}

        {/* Existing secrets */}
        <div className="mt-8">
          <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400">
            {scope.label} · {names.length} secret{names.length === 1 ? "" : "s"}
          </h2>
          {names.length === 0 ? (
            <p className="mt-2 text-sm text-gray-400">None in this scope.</p>
          ) : (
            <ul className="mt-2 divide-y divide-gray-200 rounded-xl border border-gray-200 dark:divide-gray-800 dark:border-gray-800">
              {names.map((name) => (
                <li
                  key={name}
                  className="flex items-center justify-between px-4 py-3"
                >
                  <span className="font-mono text-sm">{name}</span>
                  <Form method="post">
                    <input type="hidden" name="intent" value="delete" />
                    <input type="hidden" name="env" value={envValue} />
                    <input type="hidden" name="key" value={name} />
                    <button
                      type="submit"
                      disabled={busy}
                      className="text-sm text-red-600 hover:text-red-800 disabled:opacity-50 dark:text-red-400"
                    >
                      Delete
                    </button>
                  </Form>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Add / update */}
        <Form method="post" className="mt-8 space-y-3">
          <h2 className="text-sm font-semibold">Add or update a secret</h2>
          <input type="hidden" name="intent" value="set" />
          <input type="hidden" name="env" value={envValue} />
          <input
            name="key"
            placeholder="API_KEY"
            className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 font-mono text-sm dark:border-gray-700 dark:bg-gray-900"
          />
          <input
            name="value"
            type="password"
            placeholder="value (write-only)"
            autoComplete="off"
            className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 font-mono text-sm dark:border-gray-700 dark:bg-gray-900"
          />
          <button
            type="submit"
            disabled={busy || !configured}
            className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
          >
            {busy ? "Saving…" : "Save secret"}
          </button>
        </Form>
      </div>
    </main>
  );
}
