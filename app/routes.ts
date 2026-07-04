import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("dashboard", "routes/dashboard.tsx"),
  route("org/settings", "routes/org.settings.tsx"),
  route("connect", "routes/connect.tsx"),
  // The product noun is REPOSITORY (one connected GitHub repo = a single agent or a team).
  // Param stays :projectId — internal identifiers didn't churn with the URL rename.
  route("repos/:projectId", "routes/projects.$projectId.tsx"),
  route("repos/:projectId/changes", "routes/projects.$projectId.changes.tsx"),
  route("repos/:projectId/secrets", "routes/projects.$projectId.secrets.tsx"),
  route(
    "repos/:projectId/assistant",
    "routes/projects.$projectId.assistant.tsx",
  ),
  route(
    "repos/:projectId/deployments",
    "routes/projects.$projectId.deployments.tsx",
  ),
  route(
    "repos/:projectId/playground",
    "routes/projects.$projectId.playground.tsx",
  ),
  route("repos/:projectId/runs", "routes/projects.$projectId.runs.tsx"),
  route(
    "repos/:projectId/runs/:runId",
    "routes/projects.$projectId.runs.$runId.tsx",
  ),
  route(
    "repos/:projectId/resources/:category",
    "routes/projects.$projectId.resources.$category.tsx",
  ),
  route("api/github/webhook", "routes/api.github.webhook.tsx"),
  route("api/ingest/runs", "routes/api.ingest.runs.tsx"),
  route("repos/:projectId/edit", "routes/projects.$projectId.edit.tsx"),
  // The model moved inline onto the overview; the old edit-agent page redirects there.
  route("repos/:projectId/edit/agent", "routes/legacy.edit-agent.tsx"),
  route(
    "repos/:projectId/edit/instructions",
    "routes/projects.$projectId.edit.instructions.tsx",
  ),
  route(
    "repos/:projectId/edit/schedule",
    "routes/projects.$projectId.edit.schedule.tsx",
  ),
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
