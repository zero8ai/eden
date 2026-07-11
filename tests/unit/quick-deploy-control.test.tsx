import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { QuickDeployControl } from "~/components/quick-deploy";
import { TooltipProvider } from "~/components/ui/tooltip";

describe("QuickDeployControl", () => {
  it("keeps Quick deploy visible but unavailable when no changes are staged", () => {
    const html = renderToString(
      <TooltipProvider>
        <QuickDeployControl
          action="/repos/proj_1/quick-deploy"
          agent={null}
          data={{ draftCount: 0, groups: [], members: [], envNames: [] }}
        />
      </TooltipProvider>,
    );

    expect(html).toContain("<button");
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('disabled=""');
    expect(html).toContain("Quick deploy</button>");
    expect(html).toContain(
      'aria-label="Quick deploy unavailable. Make and save an edit to stage a change, then use Quick deploy."',
    );
    expect(html).not.toContain('aria-haspopup="dialog"');
  });
});
