import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  // Worktrees created by scripts/worktree-setup.mjs get a unique PORT written
  // into their .env.local; the main checkout has no PORT and keeps 5173.
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [tailwindcss(), reactRouter()],
    resolve: {
      tsconfigPaths: true,
    },
    server: {
      port: Number(env.PORT ?? 5173),
      // Containerized eve instances (the built-in assistant, team-delegation peers) call back
      // into Eden's dev server via `host.docker.internal`. Vite's dev server rejects Host
      // headers it doesn't recognise with a 403, so allow that one explicitly (dev-only; the
      // production server is react-router-serve, which has no host allowlist).
      allowedHosts: ["host.docker.internal"],
    },
  };
});
