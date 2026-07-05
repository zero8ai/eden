/**
 * Deploy a Worker app to Cloudflare.
 *
 * Runs the app's `npm run deploy` — in a create-cloudflare React project that
 * is `npm run build && wrangler deploy`, publishing the SPA assets and the
 * Worker together to *.workers.dev (or the custom domain in wrangler.jsonc).
 * Credentials come from the environment, never from the model: set
 * CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID as secrets (the install
 * wizard creates the placeholders). The token needs the "Edit Cloudflare
 * Workers" permission for the target account.
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
    "Deploy a Cloudflare Worker app (npm run deploy: build + wrangler deploy). Use after " +
    "check-app passes. Returns wrangler's output, including the deployed URL on success.",
  inputSchema: z.object({
    cwd: z.string().describe("The app directory (where package.json and wrangler.jsonc live)."),
  }),
  async execute({ cwd }) {
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

    try {
      const { stdout, stderr } = await run("npm", ["run", "deploy"], {
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
      return { ok: false, error: tail(err.stderr || err.stdout || err.message) };
    }
  },
});
