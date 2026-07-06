import { defineTool } from "eve/tools";
import { z } from "zod";

import { edenCall } from "../lib/edenApi";

export default defineTool({
  description:
    "Stage the DELETION of a file as a draft (removed on the same Changes review rails as an " +
    "edit). Same path policy as write_file.",
  inputSchema: z.object({
    path: z.string().describe("Repo-relative path of the file to delete."),
  }),
  async execute({ path }) {
    return edenCall("delete-file", { path });
  },
});
