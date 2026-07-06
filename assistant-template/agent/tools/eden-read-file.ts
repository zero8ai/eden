import { defineTool } from "eve/tools";
import { z } from "zod";

import { edenCall } from "../lib/edenApi";

export default defineTool({
  description:
    "Read a file's current content — a staged draft if one exists, else the open change " +
    "request, else the default branch. Always read the closest existing examples before " +
    "writing new code.",
  inputSchema: z.object({
    path: z.string().describe("Repo-relative path, e.g. agents/pm/agent/tools/foo.ts"),
  }),
  async execute({ path }) {
    return edenCall("read-file", { path });
  },
});
