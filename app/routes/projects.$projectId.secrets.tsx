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

import { AgentNav, AppShell, PageHeader } from "~/components/shell";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  listAgentEnvironments,
  listAgents,
  type Agent,
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

/** Resolve the `?env=` param to an environmentId (null == agent-wide), validated. */
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

/**
 * The roster member whose secrets we're managing — `?agent=` for teams, else the first
 * member (single-agent repos are a team of one, so this is invisible today). Secrets scope
 * per agent by decision (PRD §7.9): a teammate never sees another's credentials.
 */
async function resolveAgent(projectId: string, raw: string | null): Promise<Agent | null> {
  const roster = await listAgents(projectId);
  return roster.find((a) => a.id === raw || a.name === raw) ?? roster[0] ?? null;
}


export const loader = (args: LoaderFunctionArgs) =>
  authkitLoader(
    args,
    async ({ auth }): Promise<SecretsView> => {
      const project = await requireProject(
        { user: auth.user, organizationId: auth.organizationId, role: auth.role },
        args.params.projectId,
      );
      const url = new URL(args.request.url);
      const agent = await resolveAgent(project.id, url.searchParams.get("agent"));
      if (!agent) throw new Error("Project has no agents.");
      const envs = await listAgentEnvironments(agent.id);
      const scope = resolveScope(url.searchParams.get("env"), envs);

      try {
        const names = await getRuntime().secrets.listNames({
          projectId: project.id,
          agentId: agent.id,
          environmentId: scope.environmentId,
        });
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
  const agent = await resolveAgent(project.id, String(form.get("agent") ?? "") || null);
  if (!agent) return { error: "Project has no agents." };
  const envs = await listAgentEnvironments(agent.id);
  const { environmentId } = resolveScope(envRaw, envs);
  const key = String(form.get("key") ?? "").trim();
  const back = `/projects/${project.id}/secrets?env=${encodeURIComponent(envRaw)}`;

  const secrets = getRuntime().secrets;
  const ref = { projectId: project.id, agentId: agent.id, environmentId, key };
  try {
    if (intent === "set") {
      const value = String(form.get("value") ?? "");
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        return { error: "Key must be a valid env var name (A–Z, 0–9, _)." };
      }
      if (!value) return { error: "Value is required." };
      await secrets.set(ref, value);
    } else if (intent === "delete") {
      await secrets.delete(ref);
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

  const base = `/projects/${project.id}`;

  return (
    <AppShell workspaceName={project.name}>
      <PageHeader
        title="Secrets"
        description="Stored encrypted, never in the repo. Reference them by name in tools and connections; values are injected at deploy time."
        actions={
          <Button variant="outline" asChild>
            <Link to={base}>← {project.name}</Link>
          </Button>
        }
      />
      <AgentNav base={base} />

      {/* Scope selector */}
      <Form method="get" className="flex items-center gap-2">
        <Label htmlFor="secret-scope">Scope</Label>
        <Select name="env" defaultValue={envValue}>
          <SelectTrigger id="secret-scope" className="min-w-44">
            <SelectValue placeholder="Scope" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All environments</SelectItem>
            {envs.map((e) => (
              <SelectItem key={e.id} value={e.id}>
                {e.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="submit" variant="secondary">
          Switch
        </Button>
      </Form>

      {!configured && (
        <Alert className="mt-6">
          <AlertTitle>Secrets store not configured.</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {actionData?.error && (
        <Alert variant="destructive" className="mt-6">
          <AlertDescription>{actionData.error}</AlertDescription>
        </Alert>
      )}

      {/* Existing secrets */}
      <Card className="mt-8">
        <CardHeader>
          <CardTitle className="text-sm font-semibold text-muted-foreground">
            {scope.label} · {names.length} secret{names.length === 1 ? "" : "s"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {names.length === 0 ? (
            <p className="text-sm text-muted-foreground">None in this scope.</p>
          ) : (
            <ul className="divide-y divide-border rounded-xl border">
              {names.map((name) => (
                <li
                  key={name}
                  className="flex items-center justify-between gap-2 px-4 py-3"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm">{name}</span>
                    <Badge variant={scope.environmentId ? "secondary" : "outline"}>
                      {scope.environmentId ? scope.label : "project-wide"}
                    </Badge>
                  </div>
                  <Form method="post">
                    <input type="hidden" name="intent" value="delete" />
                    <input type="hidden" name="env" value={envValue} />
                    <input type="hidden" name="key" value={name} />
                    <Button
                      type="submit"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      className="text-destructive hover:text-destructive"
                    >
                      Delete
                    </Button>
                  </Form>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Add / update */}
      <Card className="mt-8">
        <CardHeader>
          <CardTitle className="text-sm font-semibold">
            Add or update a secret
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Form method="post" className="space-y-3">
            <input type="hidden" name="intent" value="set" />
            <input type="hidden" name="env" value={envValue} />
            <div className="space-y-1.5">
              <Label htmlFor="secret-key">Key</Label>
              <Input
                id="secret-key"
                name="key"
                placeholder="API_KEY"
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="secret-value">Value</Label>
              <Input
                id="secret-value"
                name="value"
                type="password"
                placeholder="value (write-only)"
                autoComplete="off"
                className="font-mono"
              />
            </div>
            <Button type="submit" disabled={busy || !configured}>
              {busy ? "Saving…" : "Save secret"}
            </Button>
          </Form>
        </CardContent>
      </Card>
    </AppShell>
  );
}
