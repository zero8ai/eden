import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import type { Project } from "~/db/queries.server";
import { TeamCard } from "~/routes/dashboard";

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "proj_1",
    name: "Support Crew",
    repoOwner: "acme",
    repoName: "support",
    defaultBranch: "main",
    ...overrides,
  } as Project;
}

function render(card: {
  project: Project;
  members: string[];
  isTeam: boolean;
}) {
  // React SSR emits `<!-- -->` markers between adjacent text/expression
  // segments; strip them so substring assertions see contiguous text.
  return renderToString(
    <MemoryRouter>
      <TeamCard card={card} />
    </MemoryRouter>,
  ).replace(/<!-- -->/g, "");
}

describe("TeamCard", () => {
  it("shows the plural agent badge for a multi-agent team", () => {
    const html = render({
      project: makeProject(),
      members: ["engineer", "researcher"],
      isTeam: true,
    });
    expect(html).toContain("Team · 2 agents");
  });

  it("shows the singular agent badge for a single-agent team", () => {
    const html = render({
      project: makeProject(),
      members: ["engineer"],
      isTeam: true,
    });
    expect(html).toContain("Team · 1 agent");
    expect(html).not.toContain("Team · 1 agents");
  });

  it("does not render any agent names on the card", () => {
    const html = render({
      project: makeProject(),
      members: ["engineer", "researcher"],
      isTeam: true,
    });
    expect(html).not.toContain("engineer");
    expect(html).not.toContain("researcher");
  });

  it("renders repo metadata when a repo is linked", () => {
    const html = render({
      project: makeProject({ repoOwner: "acme", repoName: "support" }),
      members: ["engineer", "researcher"],
      isTeam: true,
    });
    expect(html).toContain("acme/support");
    expect(html).toContain("main");
  });

  it("renders a no-repository notice when no repo is linked", () => {
    const html = render({
      project: makeProject({ repoOwner: null, repoName: null }),
      members: ["engineer", "researcher"],
      isTeam: true,
    });
    expect(html).toContain("No repository linked");
  });
});
