import { defineTool } from "eve/tools";
import { z } from "zod";

import { edenCall } from "../lib/edenApi";

const templateType = z.enum([
  "tool",
  "skill",
  "subagent",
  "channel",
  "connection",
  "bundle",
  "agent",
]);

export default defineTool({
  description:
    "Install an Eden marketplace template into the connected project through Eden's real " +
    "installer. Always browse with eden_catalog first, then use this tool instead of copying " +
    "template files. It composes bundles/includes, stages the template and eden-lock.json, " +
    "merges dependencies and sandbox bootstrap setup, provisions supplied or shared secrets, " +
    "and snapshots auth/capability selections. Conflicts stage nothing. For an agent template, " +
    "member is the new team-member name; otherwise it is an existing member name. secretValues " +
    "are write-only and are never returned.",
  inputSchema: z.object({
    type: templateType,
    id: z.string().describe("The template id returned by eden_catalog."),
    member: z
      .string()
      .describe(
        "Existing target member, or the new name for an agent template.",
      ),
    authSelections: z
      .record(z.string(), z.array(z.string()))
      .optional()
      .describe(
        "OAuth provider id to selected scope-group ids. Omit to use defaults.",
      ),
    capabilitySelections: z
      .record(z.string(), z.array(z.string()))
      .optional()
      .describe(
        "Capability provider id to selected operation-group ids. Omit for defaults.",
      ),
    secretValues: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        "Optional manifest secret values. Existing shared secrets attach automatically when no value is supplied; all other omitted secrets remain required for later setup.",
      ),
  }),
  async execute(input) {
    return edenCall("install", input);
  },
});
