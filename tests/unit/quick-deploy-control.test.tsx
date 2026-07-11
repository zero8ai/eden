import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";

import { QuickDeployControl } from "~/components/quick-deploy";
import { TooltipProvider } from "~/components/ui/tooltip";

// The enabled control mounts QuickDeployDialog, which calls useFetcher — that needs a data router
// in context. Wrap the control in a routes stub so SSR can resolve the fetcher hooks.
function renderInRouter(ui: React.ReactElement): string {
  const Stub = createRoutesStub([{ path: "/", Component: () => ui }]);
  return renderToString(<Stub initialEntries={["/"]} />);
}

describe("QuickDeployControl", () => {
  it("keeps Quick deploy visible but disabled for a genuinely undeployable repo", () => {
    const html = renderToString(
      <TooltipProvider>
        <QuickDeployControl
          action="/repos/proj_1/quick-deploy"
          agent={null}
          data={{
            draftCount: 0,
            groups: [],
            members: [],
            envNames: [],
            headBranch: null,
            headSha: null,
          }}
        />
      </TooltipProvider>,
    );

    expect(html).toContain("<button");
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('disabled=""');
    expect(html).toContain("Quick deploy</button>");
    expect(html).toContain(
      'aria-label="Quick deploy unavailable. Quick deploy needs a connected repository with detected agents."',
    );
    expect(html).not.toContain('aria-haspopup="dialog"');
    // The disabled copy must never instruct the user to make an edit (issue #101).
    expect(html.toLowerCase()).not.toContain("edit");
  });

  it("enables an ENABLED HEAD-mode trigger when a ready repo has zero drafts", () => {
    const html = renderInRouter(
      <TooltipProvider>
        <QuickDeployControl
          action="/repos/proj_1/quick-deploy"
          agent={null}
          data={{
            draftCount: 0,
            groups: [],
            members: ["alpha", "beta"],
            envNames: ["production"],
            headBranch: "main",
            headSha: "face".repeat(10),
          }}
        />
      </TooltipProvider>,
    );

    // An available dialog trigger, not a disabled button.
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).not.toContain('disabled=""');
    expect(html).toContain("Quick deploy");
    // No make-an-edit instruction anywhere.
    expect(html.toLowerCase()).not.toContain("make an edit");
    expect(html.toLowerCase()).not.toContain("stage a change");
  });
});
