import { defineTool } from "eve/tools";
import { z } from "zod";

import { edenCall } from "../lib/edenApi";

export default defineTool({
  description:
    "Learn the repository at a glance: whether it is a single agent or a team, the roster of " +
    "members (name, root directory, the NAMES of secrets each has set), your own configured " +
    "instructions/skills/schedules, and everything currently staged as drafts. Use this to " +
    "orient before acting, and to know which member a request is about.",
  inputSchema: z.object({}),
  async execute() {
    return edenCall("project-context");
  },
});
