import { type RouteConfig, index, route } from "@react-router/dev/routes";

/**
 * The repository hierarchy is two-level (M5.8): repo pages at /repos/:projectId/..., a team
 * member's pages at /repos/:projectId/agents/:agentName/... Single-agent repos collapse to
 * the repo level. One module serves both levels via a second registration with an explicit
 * id (React Router requires unique ids; params.agentName distinguishes at runtime).
 */
const memberRoute = (tail: string, file: string, id: string) =>
  route(`repos/:projectId/agents/:agentName${tail}`, file, { id });

const mobileMemberRoute = (tail: string, file: string, id: string) =>
  route(`api/mobile/repos/:projectId/agents/:agentName${tail}`, file, { id });

export default [
  index("routes/home.tsx"),
  route("sitemap.xml", "routes/sitemap[.]xml.tsx"),
  // Marketing case studies — index + one page per vertical.
  route("case-studies", "routes/case-studies.tsx"),
  route("case-studies/:slug", "routes/case-studies.$slug.tsx"),
  route("dashboard", "routes/dashboard.tsx"),
  // Recruit — the marketplace (PRD §7.8, M6). Browse (index.json) + a template detail page.
  route("marketplace", "routes/marketplace.tsx"),
  route("marketplace/:type/:id", "routes/marketplace.$type.$id.tsx"),
  route(
    "marketplace/:type/:id/install",
    "routes/marketplace.$type.$id.install.tsx",
  ),
  route("org/settings", "routes/org.settings.tsx"),
  // Shared workspaces (issue #56): the members/invite page, the multi-workspace chooser +
  // switch endpoint, and the shell switcher's data route.
  route("org/members", "routes/org.members.tsx"),
  route("workspaces", "routes/workspaces.tsx"),
  route("api/workspaces", "routes/api.workspaces.tsx"),
  route("connect", "routes/connect.tsx"),
  route(
    "github/mobile-install/callback",
    "routes/github.mobile-install.callback.tsx",
  ),
  // Native clients use resource routes backed by the same loaders/actions as the web UI. Keeping
  // these modules component-free makes GET/POST responses JSON rather than rendered documents.
  route("api/mobile/dashboard", "routes/api.mobile.dashboard.ts"),
  route("api/mobile/marketplace", "routes/api.mobile.marketplace.ts"),
  route(
    "api/mobile/marketplace/:type/:id",
    "routes/api.mobile.marketplace.$type.$id.ts",
  ),
  route(
    "api/mobile/marketplace/:type/:id/install",
    "routes/api.mobile.marketplace.$type.$id.install.ts",
  ),
  route("api/mobile/workspaces", "routes/api.mobile.workspaces.ts"),
  route("api/mobile/org/settings", "routes/api.mobile.org.settings.ts"),
  route("api/mobile/org/members", "routes/api.mobile.org.members.ts"),
  route("api/mobile/connect", "routes/api.mobile.connect.ts"),
  route(
    "api/mobile/github/install/start",
    "routes/api.mobile.github-install.start.ts",
  ),
  route(
    "api/mobile/github/install/redeem",
    "routes/api.mobile.github-install.redeem.ts",
  ),
  route("api/mobile/repos/:projectId", "routes/api.mobile.repository.ts"),
  mobileMemberRoute(
    "",
    "routes/api.mobile.repository.ts",
    "mobile-member-overview",
  ),
  route(
    "api/mobile/repos/:projectId/deployment",
    "routes/api.mobile.repository.deployment.ts",
  ),
  mobileMemberRoute(
    "/deployment",
    "routes/api.mobile.repository.deployment.ts",
    "mobile-member-deployment",
  ),
  route(
    "api/mobile/repos/:projectId/settings",
    "routes/api.mobile.repository.settings.ts",
  ),
  mobileMemberRoute(
    "/settings",
    "routes/api.mobile.repository.settings.ts",
    "mobile-member-settings",
  ),
  route(
    "api/mobile/repos/:projectId/playground",
    "routes/api.mobile.repository.playground.ts",
  ),
  mobileMemberRoute(
    "/playground",
    "routes/api.mobile.repository.playground.ts",
    "mobile-member-playground",
  ),
  route(
    "api/mobile/repos/:projectId/runs",
    "routes/api.mobile.repository.runs.ts",
  ),
  mobileMemberRoute(
    "/runs",
    "routes/api.mobile.repository.runs.ts",
    "mobile-member-runs",
  ),
  route(
    "api/mobile/repos/:projectId/runs/:runId",
    "routes/api.mobile.repository.run.ts",
  ),
  mobileMemberRoute(
    "/runs/:runId",
    "routes/api.mobile.repository.run.ts",
    "mobile-member-run",
  ),
  route(
    "api/mobile/repos/:projectId/assistant",
    "routes/api.mobile.repository.assistant.ts",
  ),
  route(
    "api/mobile/repos/:projectId/assistant/config",
    "routes/api.mobile.repository.assistant-config.ts",
  ),
  route(
    "api/mobile/repos/:projectId/resources/:category",
    "routes/api.mobile.repository.resources.ts",
  ),
  mobileMemberRoute(
    "/resources/:category",
    "routes/api.mobile.repository.resources.ts",
    "mobile-member-resources",
  ),
  route(
    "api/mobile/repos/:projectId/edit",
    "routes/api.mobile.repository.edit.ts",
  ),
  mobileMemberRoute(
    "/edit",
    "routes/api.mobile.repository.edit.ts",
    "mobile-member-edit",
  ),
  route(
    "api/mobile/repos/:projectId/edit/instructions",
    "routes/api.mobile.repository.instructions.ts",
  ),
  mobileMemberRoute(
    "/edit/instructions",
    "routes/api.mobile.repository.instructions.ts",
    "mobile-member-instructions",
  ),
  route(
    "api/mobile/repos/:projectId/edit/schedule",
    "routes/api.mobile.repository.schedule.ts",
  ),
  mobileMemberRoute(
    "/edit/schedule",
    "routes/api.mobile.repository.schedule.ts",
    "mobile-member-schedule",
  ),
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
  route("repos/:projectId/settings", "routes/projects.$projectId.settings.tsx"),
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
  route(
    "repos/:projectId/assistant/config",
    "routes/projects.$projectId.assistant.config.tsx",
  ),
  // The assistant is project-level now; the old member-level tab 301s to the repo-level page.
  memberRoute(
    "/assistant",
    "routes/shims.member-assistant.tsx",
    "member-assistant",
  ),
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
  // Workspace task-progress indicator (issue #142): running + recent terminal merge/publish tasks
  // for this project. GET polls the list; POST intent=dismiss clears a terminal row.
  route("repos/:projectId/tasks", "routes/api.tasks.tsx"),
  // Quick deploy (AgentNav): GET returns the button's envs + staged count for the scope,
  // POST runs the whole Ship pipeline. `?agent=`/`agent` field scopes to one member.
  route("repos/:projectId/quick-deploy", "routes/api.quick-deploy.tsx"),
  // Playground streaming turn: the page POSTs here and reads an NDJSON stream of the turn.
  // Single registration — team-member selection travels as a form field, not a URL param.
  route(
    "api/repos/:projectId/playground/stream",
    "routes/api.projects.$projectId.playground.stream.ts",
  ),
  route(
    "api/repos/:projectId/playground/stop",
    "routes/api.projects.$projectId.playground.stop.ts",
  ),
  // Assistant streaming turn (project-level sibling of the playground stream).
  route(
    "api/repos/:projectId/assistant/stream",
    "routes/api.projects.$projectId.assistant.stream.ts",
  ),
  route("api/github/webhook", "routes/api.github.webhook.tsx"),
  // Per-agent GitHub App Manifest flow (issue #26): submit the manifest to GitHub, then
  // GitHub redirects back to the callback with a single-use code to convert.
  route("github/apps/new", "routes/github.apps.new.tsx"),
  route("github/apps/callback", "routes/github.apps.callback.tsx"),
  // One-click Discord channel (issue #32): Eden's shared app. The relay is the app's single
  // Interactions Endpoint URL; connect/callback run the OAuth authorize + guild-command
  // registration; send is the control-plane proxy the discord-send-message tool calls.
  route("api/discord/interactions", "routes/api.discord.interactions.ts"),
  route("discord/connect", "routes/discord.connect.tsx"),
  route("discord/callback", "routes/discord.callback.tsx"),
  route("api/discord/send", "routes/api.discord.send.ts"),
  // Install-time auth-brokered connections (issue #30): Eden brokers Google OAuth against the
  // operator's shared client. connect signs state + redirects to consent; callback exchanges the
  // code and seals the grant. The grant is injected as env at deploy so eve self-refreshes tokens.
  route("google/connect", "routes/google.connect.tsx"),
  route("google/callback", "routes/google.callback.tsx"),
  route("api/ingest/runs", "routes/api.ingest.runs.tsx"),
  // Teammate delegation relay: a team member's ask-teammate tool POSTs here (Bearer token).
  route("api/team/ask", "routes/api.team.ask.ts"),
  // Built-in assistant callback API. The assistant instance's baked-in
  // tools + boot entrypoint call GET|POST /api/assistant/<action> with a Bearer assistant token.
  route("api/assistant/:action", "routes/api.assistant.$action.ts"),
  route("api/models", "routes/api.models.tsx"),
  // Eden model gateway (issue #28): a deployed agent / the assistant set to a codex/<conn>/<slug>
  // model reaches this route (Bearer edng_ token) to run on the org's connected Codex subscription.
  route("api/gateway/v1/chat/completions", "routes/api.gateway.chat.ts"),
  // Connect an OpenAI Codex subscription via device-code OAuth (Org settings dialog fetcher).
  route("api/connections/codex", "routes/api.connections.codex.ts"),
  // Better Auth's documented React Router resource route. The splat forwards every
  // /api/auth/* request to the single server auth instance.
  route("api/auth/*", "routes/api.auth.$.ts"),
  // Legacy URLs from before the repositories rename — 301 into /repos/.
  route("projects/:projectId/*", "routes/legacy.projects.tsx", {
    id: "legacy-projects-splat",
  }),
  route("projects/:projectId", "routes/legacy.projects.tsx", {
    id: "legacy-projects",
  }),
  route(
    "accept-invitation/:invitationId",
    "routes/accept-invitation.$invitationId.tsx",
  ),
  route("login", "routes/login.tsx"),
  route("signup", "routes/signup.tsx"),
  route("forgot-password", "routes/forgot-password.tsx"),
  route("reset-password", "routes/reset-password.tsx"),
] satisfies RouteConfig;
