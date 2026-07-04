/**
 * Deploy a Cloudflare Worker.
 *
 * A thin, honest wrapper around `wrangler deploy`: it shells out to the pinned wrangler CLI
 * (added to your agent's package.json by this template) and returns the tail of its output so
 * the model can confirm the deploy — or read the error and react. Credentials come from the
 * environment, never from the model: set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID as
 * secrets (the install wizard creates the placeholders). The token needs the "Edit Cloudflare
 * Workers" permission for the target account.
 *
 * This file is a customer-facing exemplar — it's meant to be read, edited, and owned. Past ~200
 * lines a tool should move its logic into a published npm package and keep only a wrapper here
 * (PRD §7.8, "Heavy dependencies").
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
    "Deploy the current Cloudflare Worker with wrangler. Use after the Worker's code is ready " +
    "to publish. Returns wrangler's output, including the deployed URL on success.",
  inputSchema: z.object({
    cwd: z
      .string()
      .optional()
      .describe("Directory containing wrangler.toml (defaults to the project root)."),
    env: z
      .string()
      .optional()
      .describe("Named wrangler environment to deploy, e.g. 'production'."),
    dryRun: z
      .boolean()
      .optional()
      .describe("Build and validate without publishing (wrangler --dry-run)."),
  }),
  async execute({ cwd, env, dryRun }) {
    const token = process.env.CLOUDFLARE_API_TOKEN;
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    if (!token || !accountId) {
      return {
        ok: false,
        error:
          "Missing Cloudflare credentials. Set CLOUDFLARE_API_TOKEN and " +
          "CLOUDFLARE_ACCOUNT_ID as secrets before deploying.",
      };
    }

    const args = ["wrangler", "deploy"];
    if (env) args.push("--env", env);
    if (dryRun) args.push("--dry-run");

    try {
      // `npx` resolves the wrangler pinned in package.json; credentials go in via env only.
      const { stdout, stderr } = await run("npx", args, {
        cwd,
        env: {
          ...process.env,
          CLOUDFLARE_API_TOKEN: token,
          CLOUDFLARE_ACCOUNT_ID: accountId,
        },
        maxBuffer: 10 * 1024 * 1024,
      });
      return { ok: true, output: tail(`${stdout}\n${stderr}`) };
    } catch (error) {
      // wrangler exits non-zero on a failed deploy — surface its stderr, not a bare stack.
      const err = error as { stdout?: string; stderr?: string; message: string };
      return {
        ok: false,
        error: tail(err.stderr || err.stdout || err.message),
      };
    }
  },
});
