import { defineTool } from "eve/tools";
import { z } from "zod";

import { edenCall } from "../lib/edenApi";

export default defineTool({
  description:
    "Stage the full new contents of a file as a draft (create or overwrite) for human review on " +
    "the Changes tab. Never touches git. Writable: any member file under agent/ or " +
    "agents/<member>/agent/, and your own .eden/assistant/instructions.md, .eden/assistant/" +
    "skills/*.md, .eden/assistant/schedules/*.md. NOT package.json/package-lock.json (use " +
    "add_dependency) and NOT any .ts under .eden/assistant.",
  inputSchema: z.object({
    path: z.string().describe("Repo-relative path of the file to write."),
    content: z.string().describe("The complete new file contents."),
  }),
  async execute({ path, content }) {
    return edenCall("write-file", { path, content });
  },
});
