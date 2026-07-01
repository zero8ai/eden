import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("dashboard", "routes/dashboard.tsx"),
  route("connect", "routes/connect.tsx"),
  route("projects/:projectId", "routes/projects.$projectId.tsx"),
  route(
    "projects/:projectId/edit/instructions",
    "routes/projects.$projectId.edit.instructions.tsx",
  ),
  route("callback", "routes/callback.tsx"),
  route("login", "routes/login.tsx"),
  route("signup", "routes/signup.tsx"),
] satisfies RouteConfig;
