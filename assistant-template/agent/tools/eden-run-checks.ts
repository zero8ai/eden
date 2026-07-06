import { defineTool } from "eve/tools";
import { z } from "zod";

import { edenCall } from "../lib/edenApi";

export default defineTool({
  description:
    "Compile-check the affected member with all staged drafts applied: installs dependencies, " +
    "runs eve build, then the repo's typecheck/lint scripts if present — exactly like a real " +
    "deploy. Returns whether it passed or the errors to fix. Assistant-only config changesets " +
    "(.eden/assistant markdown) skip the build (nothing to compile). Run this after writing " +
    "files and fix any errors before you finish.",
  inputSchema: z.object({}),
  async execute() {
    return edenCall("run-checks");
  },
});
