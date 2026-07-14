import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";

import { PostMergeDeployBanner } from "~/routes/projects.$projectId.deployments";
import { TooltipProvider } from "~/components/ui/tooltip";

// PostMergeDeployBanner uses useFetcher (to submit the deploy-team-version intent), which needs a
// data router in context. Wrap it in a routes stub so SSR can resolve the fetcher hooks.
function renderInRouter(ui: React.ReactElement): string {
  const Stub = createRoutesStub([{ path: "/", Component: () => ui }]);
  const html = renderToString(
    <TooltipProvider>
      <Stub initialEntries={["/"]} />
    </TooltipProvider>,
  );
  // React inserts <!-- --> markers between adjacent text nodes; strip them so assertions can match
  // interpolated copy like "v7 is ready" as a contiguous string.
  return html.replace(/<!-- -->/g, "");
}

const guard = { missing: [], activeAgent: "alpha", settingsAction: "/settings" };

const versionRow = (overrides: Partial<TeamVersionRowShape> = {}) => ({
  gitSha: "abc1234def",
  version: "v7",
  changelog: "changes",
  createdAt: new Date("2026-07-14T00:00:00Z"),
  runningEnvNames: [] as string[],
  ...overrides,
});

// Local structural type mirroring TeamVersionRow (not exported from the route module).
type TeamVersionRowShape = {
  gitSha: string;
  version: string;
  changelog: string | null;
  createdAt: Date;
  runningEnvNames: string[];
};

describe("PostMergeDeployBanner", () => {
  it("renders a primary Deploy version CTA and the ready title", () => {
    const html = renderInRouter(
      <PostMergeDeployBanner
        version="v7"
        teamVersions={[versionRow()]}
        teamEnvNames={["production"]}
        guard={guard}
      />,
    );

    expect(html).toContain("v7 is ready");
    expect(html).toContain("Deploy version v7");
    expect(html).toContain("<button");
    // The stale per-agent copy must be gone (issue #147).
    expect(html).not.toContain("from each agent's Deployment tab");
  });

  it("falls back to text with no deploy button when there is no environment", () => {
    const html = renderInRouter(
      <PostMergeDeployBanner
        version="v7"
        teamVersions={[versionRow()]}
        teamEnvNames={[]}
        guard={guard}
      />,
    );

    expect(html).toContain("v7 is ready");
    expect(html).not.toContain("Deploy version v7");
    expect(html).not.toContain("<button");
  });

  it("reads Redeploy version when the target already runs in the only env", () => {
    const html = renderInRouter(
      <PostMergeDeployBanner
        version="v7"
        teamVersions={[versionRow({ runningEnvNames: ["production"] })]}
        teamEnvNames={["production"]}
        guard={guard}
      />,
    );

    expect(html).toContain("Redeploy version v7");
    expect(html).not.toContain("Deploy version v7");
  });
});
