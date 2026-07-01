/**
 * Read-only visualization of a connected eve agent's config surface (M0, Step 4).
 *
 * Proves the parse layer before M1 adds editors. Reads the repo through the GitHub App and
 * renders the normalized AgentConfig — model, instructions, and each eve concept category.
 */
import { authkitLoader } from "@workos-inc/authkit-react-router";
import { Link, data, type LoaderFunctionArgs } from "react-router";

import { syncTenant } from "~/auth/tenant.server";
import { getProject } from "~/db/queries.server";
import { buildAgentConfig } from "~/eve/parse";
import { AGENT_CATEGORIES, type AgentConfig } from "~/eve/types";
import { fetchAgentSource } from "~/github/repo.server";
import type { Project } from "~/db/queries.server";
import type { Route } from "./+types/projects.$projectId";

interface ProjectView {
  project: Project;
  config: AgentConfig | null;
  error: string | null;
}

export const loader = (args: LoaderFunctionArgs) =>
  authkitLoader(
    args,
    async ({ auth }): Promise<ProjectView> => {
      const { org } = await syncTenant({
        user: auth.user,
        organizationId: auth.organizationId,
        role: auth.role,
      });
      if (!org) throw data("No organization", { status: 403 });

      const project = await getProject(org.id, args.params.projectId!);
      if (!project) throw data("Project not found", { status: 404 });

      if (!project.repoInstallationId || !project.repoOwner || !project.repoName) {
        return { project, config: null, error: "This project has no connected repo." };
      }

      try {
        const source = await fetchAgentSource(project.repoInstallationId, {
          owner: project.repoOwner,
          repo: project.repoName,
        });
        return { project, config: buildAgentConfig(source), error: null };
      } catch (error) {
        return { project, config: null, error: (error as Error).message };
      }
    },
    { ensureSignedIn: true },
  );

export function meta() {
  return [{ title: "Project · Eden" }];
}

export default function ProjectDetail({ loaderData }: Route.ComponentProps) {
  const { project, config, error } = loaderData;

  return (
    <main className="min-h-screen px-6 py-12 text-gray-900 dark:text-gray-100">
      <div className="mx-auto max-w-4xl">
        <Link
          to="/dashboard"
          className="text-sm font-medium uppercase tracking-widest text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"
        >
          ← Dashboard
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          {project.name}
        </h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          {project.repoOwner && project.repoName
            ? `${project.repoOwner}/${project.repoName} · ${project.defaultBranch}`
            : "no repo connected"}
        </p>

        {error && (
          <p className="mt-6 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-200">
            {error}
          </p>
        )}

        {config && <AgentSurface config={config} projectId={project.id} />}
      </div>
    </main>
  );
}

function AgentSurface({
  config,
  projectId,
}: {
  config: AgentConfig;
  projectId: string;
}) {
  return (
    <div className="mt-8 space-y-8">
      <section className="rounded-xl border border-gray-200 p-5 dark:border-gray-800">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Agent</h2>
          <span className="text-xs font-medium text-gray-400">
            {config.hasAgentModule ? "agent.ts present" : "no agent.ts"}
          </span>
        </div>
        <dl className="mt-3 text-sm">
          <div className="flex gap-2">
            <dt className="text-gray-500 dark:text-gray-400">Model</dt>
            <dd className="font-mono">{config.model ?? "—"}</dd>
          </div>
        </dl>
      </section>

      <section>
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">Instructions</h2>
          <Link
            to={`/projects/${projectId}/edit/instructions`}
            className="text-sm font-medium text-gray-600 underline underline-offset-4 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white"
          >
            Edit
          </Link>
        </div>
        {config.instructions ? (
          <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap rounded-xl border border-gray-200 bg-gray-50 p-4 text-sm dark:border-gray-800 dark:bg-gray-900/40">
            {config.instructions}
          </pre>
        ) : (
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
            No instructions.md found.
          </p>
        )}
      </section>

      <div className="grid gap-4 sm:grid-cols-2">
        {AGENT_CATEGORIES.map((cat) => {
          const items = config[cat.key];
          return (
            <section
              key={cat.key}
              className="rounded-xl border border-gray-200 p-5 dark:border-gray-800"
            >
              <div className="flex items-baseline justify-between">
                <h3 className="font-semibold">{cat.label}</h3>
                <span className="text-xs font-medium text-gray-400">
                  {items.length}
                </span>
              </div>
              {items.length === 0 ? (
                <p className="mt-2 text-sm text-gray-400">None</p>
              ) : (
                <ul className="mt-2 space-y-1 text-sm">
                  {items.map((item) => (
                    <li key={item.path} className="font-mono">
                      {item.name}
                      {item.isDirectory && (
                        <span className="ml-1 text-gray-400">/</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
