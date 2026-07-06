import { defineTool } from "eve/tools";
import { z } from "zod";

import { edenCall } from "../lib/edenApi";

export default defineTool({
  description:
    "Add npm packages to a member's project. Updates package.json AND regenerates " +
    "package-lock.json correctly (both staged as drafts). This is the ONLY correct way to " +
    "change dependencies — never write a manifest with write_file. Prefer fetch() and Node " +
    "built-ins; only add a real dependency when justified.",
  inputSchema: z.object({
    packages: z
      .array(z.string())
      .describe('Package specs, e.g. ["discord.js@14"] or ["pg"].'),
    agentRoot: z
      .string()
      .optional()
      .describe(
        'The member whose manifest to update: "agent" for a single-agent repo (default) or ' +
          '"agents/<member>/agent" for a team member.',
      ),
  }),
  async execute({ packages, agentRoot }) {
    return edenCall("add-dependency", { packages, agentRoot });
  },
});
