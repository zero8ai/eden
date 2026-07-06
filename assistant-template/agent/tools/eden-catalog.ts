import { defineTool } from "eve/tools";
import { z } from "zod";

import { edenCall } from "../lib/edenApi";

export default defineTool({
  description:
    "Search Eden's marketplace catalog and fetch a template's files so you can install it by " +
    'staging drafts. op "index" returns the browse index (all templates: id, type, name, ' +
    'description); op "template" returns one template\'s manifest + every file body (pass its ' +
    "type and id). To install, read the template's files and write them with write_file / " +
    "add_dependency.",
  inputSchema: z.object({
    op: z.enum(["index", "template"]),
    type: z
      .enum(["agent", "skill", "tool"])
      .optional()
      .describe('Required for op "template".'),
    id: z.string().optional().describe('Required for op "template".'),
  }),
  async execute({ op, type, id }) {
    return edenCall("catalog", { op, type, id });
  },
});
