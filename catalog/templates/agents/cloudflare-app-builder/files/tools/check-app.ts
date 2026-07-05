/**
 * Verify a Worker app builds before it ships.
 *
 * Installs dependencies (only when node_modules is missing, unless forced) and
 * runs the app's production build — the same `npm run build` that `npm run
 * deploy` performs first, so a clean check here means the deploy won't die in
 * the build step. Run this after meaningful changes and always before
 * `deploy-app`; a failing build is the fix-it signal, not a reason to retry.
 *
 * This file is a customer-facing exemplar — it's meant to be read, edited, and
 * owned.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
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
    "Install and production-build a Cloudflare Worker app to prove it compiles. Use after " +
    "changes and before deploy-app. Returns the build output tail; on failure, the error to fix.",
  inputSchema: z.object({
    cwd: z.string().describe("The app directory (where package.json lives)."),
    reinstall: z
      .boolean()
      .optional()
      .describe("Force npm install even when node_modules already exists."),
  }),
  async execute({ cwd, reinstall }) {
    const opts = { cwd, maxBuffer: 10 * 1024 * 1024 };
    try {
      if (reinstall || !existsSync(join(cwd, "node_modules"))) {
        await run("npm", ["install", "--no-audit", "--no-fund"], opts);
      }
      const { stdout, stderr } = await run("npm", ["run", "build"], opts);
      return { ok: true, output: tail(`${stdout}\n${stderr}`) };
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; message: string };
      return { ok: false, error: tail(err.stderr || err.stdout || err.message) };
    }
  },
});
