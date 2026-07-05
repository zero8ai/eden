/**
 * Scaffold a React web app on Cloudflare Workers.
 *
 * Runs Cloudflare's create-cloudflare (C3) with the React framework preset —
 * the canonical starting point from the framework guide: React + Vite SPA in
 * `src/`, Worker API backend in `worker/index.ts`, `wrangler.jsonc`, and the
 * Cloudflare Vite plugin wired up. Non-interactive: no git init, no deploy —
 * deploying is a separate, deliberate step (the `deploy-app` tool).
 *
 * This file is a customer-facing exemplar — it's meant to be read, edited, and
 * owned.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { defineTool } from "eve";
import { z } from "zod";

const run = promisify(execFile);

/** Keep tool output small and useful — the last N lines are where success/failure shows. */
function tail(text: string, lines = 40): string {
  const all = text.trimEnd().split("\n");
  return all.slice(-lines).join("\n");
}

export default defineTool({
  description:
    "Scaffold a new React + Vite web app on Cloudflare Workers (create-cloudflare with " +
    "--framework=react). Creates <name>/ with the SPA in src/, the Worker backend in " +
    "worker/index.ts, and wrangler.jsonc. Use once per app, before any editing.",
  inputSchema: z.object({
    name: z
      .string()
      .regex(
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
        "lowercase letters, digits, and single hyphens",
      )
      .describe("Directory (and app) name, e.g. 'status-dashboard'."),
    cwd: z
      .string()
      .optional()
      .describe("Parent directory to scaffold into (defaults to the project root)."),
  }),
  async execute({ name, cwd }) {
    try {
      const { stdout, stderr } = await run(
        "npm",
        [
          "create",
          "cloudflare@latest",
          "--",
          name,
          "--framework=react",
          "--no-deploy",
          "--git=false",
        ],
        { cwd, env: { ...process.env, CI: "true" }, maxBuffer: 10 * 1024 * 1024 },
      );
      return {
        ok: true,
        appDir: cwd ? `${cwd}/${name}` : name,
        output: tail(`${stdout}\n${stderr}`),
      };
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; message: string };
      return { ok: false, error: tail(err.stderr || err.stdout || err.message) };
    }
  },
});
