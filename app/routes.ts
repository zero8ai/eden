import { type RouteConfig, index, route } from "@react-router/dev/routes";

/**
 * The repository hierarchy is two-level (M5.8): repo pages at /repos/:projectId/..., a team
 * member's pages at /repos/:projectId/agents/:agentName/... Single-agent repos collapse to
 * the repo level. One module serves both levels via a second registration with an explicit
 * id (React Router requires unique ids; params.agentName distinguishes at runtime).
 */
const memberRoute = (tail: string, file: string, id: string) =>
  route(`repos/:projectId/agents/:agentName${tail}`, file, { id });

export default [
  index("routes/home.tsx"),
  route("dashboard", "routes/dashboard.tsx"),
  // Recruit — the marketplace (PRD §7.8, M6). Browse (index.json) + a template detail page.
  route("marketplace", "routes/marketplace.tsx"),
  route("marketplace/:type/:id", "routes/marketplace.$type.$id.tsx"),
  route("marketplace/:type/:id/install", "routes/marketplace.$type.$id.install.tsx"),
  route("org/settings", "routes/org.settings.tsx"),
  route("connect", "routes/connect.tsx"),
  // The product noun is REPOSITORY (one connected GitHub repo = a single agent or a team).
  // Param stays :projectId — internal identifiers didn't churn with the URL rename.
  route("repos/:projectId", "routes/projects.$projectId.tsx"),
  memberRoute("", "routes/projects.$projectId.tsx", "member-overview"),
  route(
    "repos/:projectId/deployment",
    "routes/projects.$projectId.deployments.tsx",
  ),
  memberRoute(
    "/deployment",
    "routes/projects.$projectId.deployments.tsx",
    "member-deployment",
  ),
  route(
    "repos/:projectId/settings",
    "routes/projects.$projectId.settings.tsx",
  ),
  memberRoute(
    "/settings",
    "routes/projects.$projectId.settings.tsx",
    "member-settings",
  ),
  route(
    "repos/:projectId/playground",
    "routes/projects.$projectId.playground.tsx",
  ),
  memberRoute(
    "/playground",
    "routes/projects.$projectId.playground.tsx",
    "member-playground",
  ),
  route("repos/:projectId/runs", "routes/projects.$projectId.runs.tsx"),
  memberRoute("/runs", "routes/projects.$projectId.runs.tsx", "member-runs"),
  route(
    "repos/:projectId/runs/:runId",
    "routes/projects.$projectId.runs.$runId.tsx",
  ),
  memberRoute(
    "/runs/:runId",
    "routes/projects.$projectId.runs.$runId.tsx",
    "member-run",
  ),
  route(
    "repos/:projectId/assistant",
    "routes/projects.$projectId.assistant.tsx",
  ),
  // The assistant is project-level now; the old member-level tab 301s to the repo-level page.
  memberRoute("/assistant", "routes/shims.member-assistant.tsx", "member-assistant"),
  route(
    "repos/:projectId/resources/:category",
    "routes/projects.$projectId.resources.$category.tsx",
  ),
  memberRoute(
    "/resources/:category",
    "routes/projects.$projectId.resources.$category.tsx",
    "member-resources",
  ),
  route("repos/:projectId/edit", "routes/projects.$projectId.edit.tsx"),
  memberRoute("/edit", "routes/projects.$projectId.edit.tsx", "member-edit"),
  route(
    "repos/:projectId/edit/instructions",
    "routes/projects.$projectId.edit.instructions.tsx",
  ),
  memberRoute(
    "/edit/instructions",
    "routes/projects.$projectId.edit.instructions.tsx",
    "member-edit-instructions",
  ),
  route(
    "repos/:projectId/edit/schedule",
    "routes/projects.$projectId.edit.schedule.tsx",
  ),
  memberRoute(
    "/edit/schedule",
    "routes/projects.$projectId.edit.schedule.tsx",
    "member-edit-schedule",
  ),
  // The model moved inline onto the overview; the old edit-agent page redirects there.
  route("repos/:projectId/edit/agent", "routes/legacy.edit-agent.tsx"),
  // Pre-M5.8 tab URLs — 301 into the new hierarchy (Changes/Versions → Deployment,
  // Secrets → Settings, ?agent= → /agents/:name).
  route("repos/:projectId/changes", "routes/shims.repo-tabs.tsx", {
    id: "shim-changes",
  }),
  route("repos/:projectId/deployments", "routes/shims.repo-tabs.tsx", {
    id: "shim-deployments",
  }),
  route("repos/:projectId/secrets", "routes/shims.repo-tabs.tsx", {
    id: "shim-secrets",
  }),
  // Staged-draft count for the nav pill (AgentNav); `?agent=` scopes to one member.
  route("repos/:projectId/staged-count", "routes/api.staged-count.tsx"),
  // Playground streaming turn: the page POSTs here and reads an NDJSON stream of the turn.
  // Single registration — team-member selection travels as a form field, not a URL param.
  route(
    "api/repos/:projectId/playground/stream",
    "routes/api.projects.$projectId.playground.stream.ts",
  ),
  // Assistant streaming turn (project-level sibling of the playground stream).
  route(
    "api/repos/:projectId/assistant/stream",
    "routes/api.projects.$projectId.assistant.stream.ts",
  ),
  route("api/github/webhook", "routes/api.github.webhook.tsx"),
  route("api/ingest/runs", "routes/api.ingest.runs.tsx"),
  // Teammate delegation relay: a team member's ask-teammate tool POSTs here (Bearer token).
  route("api/team/ask", "routes/api.team.ask.ts"),
  // Built-in assistant callback API (docs/ASSISTANT.md §6). The assistant instance's baked-in
  // tools + boot entrypoint call GET|POST /api/assistant/<action> with a Bearer assistant token.
  route("api/assistant/:action", "routes/api.assistant.$action.ts"),
  route("api/models", "routes/api.models.tsx"),
  // Legacy URLs from before the repositories rename — 301 into /repos/.
  route("projects/:projectId/*", "routes/legacy.projects.tsx", {
    id: "legacy-projects-splat",
  }),
  route("projects/:projectId", "routes/legacy.projects.tsx", {
    id: "legacy-projects",
  }),
  route("callback", "routes/callback.tsx"),
  route("login", "routes/login.tsx"),
  route("signup", "routes/signup.tsx"),
] satisfies RouteConfig;
