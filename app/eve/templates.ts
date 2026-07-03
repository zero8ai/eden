/**
 * Starter templates for new agent resources ("New tool/skill/…" on the Overview).
 *
 * Shapes mirror what eve itself scaffolds (eve@0.18 `setup/scaffold` + public definitions):
 * tools are `defineTool` modules, skills are markdown with a `description` frontmatter,
 * schedules are markdown with a `cron` frontmatter, channels/connections are the module
 * shapes from eve's own catalog. Pure module (client+server safe).
 */
import type { AGENT_CATEGORIES } from "./types";

type CategoryKey = (typeof AGENT_CATEGORIES)[number]["key"];

export interface ResourceKind {
  key: CategoryKey;
  /** Singular, for buttons/dialog titles: "New tool". */
  label: string;
  ext: ".ts" | ".md";
  /** One-liner shown in the create dialog. */
  hint: string;
  template(name: string): string;
}

/** kebab-case a human name into a file slug (eve derives resource identity from it). */
export function slugifyResourceName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function titleCase(slug: string): string {
  return slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export const RESOURCE_KINDS: Record<CategoryKey, ResourceKind> = {
  tools: {
    key: "tools",
    label: "tool",
    ext: ".ts",
    hint: "A function the model can call — described inputs, typed output.",
    template: (name) => `import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "What ${titleCase(name)} does and when the agent should use it.",
  inputSchema: z.object({
    query: z.string().describe("What to look up"),
  }),
  async execute({ query }) {
    // TODO: implement — return any JSON-serializable value.
    return { answer: \`${name} received: \${query}\` };
  },
});
`,
  },
  skills: {
    key: "skills",
    label: "skill",
    ext: ".md",
    hint: "Markdown guidance the agent follows when the skill applies.",
    template: (name) => `---
description: When the agent should use the ${titleCase(name)} skill.
---

# ${titleCase(name)}

Write the step-by-step guidance the agent should follow when this skill applies.

1. First…
2. Then…
`,
  },
  subagents: {
    key: "subagents",
    label: "subagent",
    ext: ".md",
    hint: "A focused helper agent the main agent can delegate to.",
    template: (name) => `---
description: What the ${titleCase(name)} subagent is for and when to delegate to it.
---

# ${titleCase(name)}

Instructions for this subagent: its job, its boundaries, and what a good
result looks like.
`,
  },
  channels: {
    key: "channels",
    label: "channel",
    ext: ".ts",
    hint: "A way to reach the agent (HTTP, Slack, web chat…).",
    template: () => `import { eveChannel } from "eve/channels/eve";
import { localDev, placeholderAuth, vercelOidc } from "eve/channels/auth";

export default eveChannel({
  auth: [
    // Lets the eve TUI and your Vercel deployments reach the deployed agent.
    vercelOidc(),
    // Open on localhost for \`eve dev\` and the REPL; ignored in production.
    localDev(),
    // Replace with your app's auth provider before real traffic.
    placeholderAuth(),
  ],
});
`,
  },
  schedules: {
    key: "schedules",
    label: "schedule",
    ext: ".md",
    hint: "A cron trigger with instructions for what to do when it fires.",
    template: (name) => `---
cron: "0 9 * * 1-5"
---

Each time this fires, the agent should: describe the ${titleCase(name)} task here.
`,
  },
  connections: {
    key: "connections",
    label: "connection",
    ext: ".ts",
    hint: "An external service the agent can use (MCP server or API).",
    template: (name) => `import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://example.com/mcp",
  description: "What the ${titleCase(name)} connection provides.",
  // auth: { getToken: async () => ({ token: process.env.MY_SERVICE_TOKEN! }) },
});
`,
  },
};

/** Path a new resource of `kind` named `slug` lives at. */
export function resourcePath(kind: ResourceKind, slug: string): string {
  return `agent/${kind.key}/${slug}${kind.ext}`;
}
