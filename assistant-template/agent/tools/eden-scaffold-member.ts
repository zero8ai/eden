import { defineTool } from "eve/tools";
import { z } from "zod";

import { edenCall } from "../lib/edenApi";

export default defineTool({
  description:
    "Create a new team member: scaffolds a complete eve project at agents/<name>/ " +
    "(instructions, agent.ts, a default sandbox, package.json) and stages it as drafts for " +
    "review. Turns a single-agent repo into a team on merge. The name is slugified; " +
    '"assistant" is reserved.',
  inputSchema: z.object({
    name: z.string().describe("The new member's name (kebab-cased), e.g. \"growth\"."),
  }),
  async execute({ name }) {
    return edenCall("scaffold-member", { name });
  },
});
