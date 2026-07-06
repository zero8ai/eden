import { defineTool } from "eve/tools";
import { z } from "zod";

import { edenCall } from "../lib/edenApi";

export default defineTool({
  description:
    "List the repository's editable files (every agent/team-member file, plus the assistant's " +
    "own .eden/assistant config). Staged (unpublished) drafts are flagged. Call this first to " +
    "learn the layout before reading or writing anything.",
  inputSchema: z.object({}),
  async execute() {
    return edenCall("list-files");
  },
});
