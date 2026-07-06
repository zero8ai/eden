/**
 * Roster description extraction (Team delegation — D3). The pure first-paragraph rule that feeds
 * each teammate's `role` blurb: skip headings/frontmatter/blank lines, collapse whitespace, cap.
 */
import { describe, expect, it } from "vitest";

import { firstParagraph } from "~/team/roster.server";

describe("firstParagraph", () => {
  it("takes the first non-heading paragraph", () => {
    const md = "# Deployer\n\nDeploys builds to production and reports the result.\n\nMore detail here.";
    expect(firstParagraph(md)).toBe(
      "Deploys builds to production and reports the result.",
    );
  });

  it("skips a leading YAML frontmatter block", () => {
    const md = "---\ntitle: PM\n---\n\n# PM\n\nManages the roadmap and triages requests.";
    expect(firstParagraph(md)).toBe("Manages the roadmap and triages requests.");
  });

  it("joins wrapped lines and collapses whitespace", () => {
    const md = "Line one\nline two\n\nnext paragraph";
    expect(firstParagraph(md)).toBe("Line one line two");
  });

  it("caps long paragraphs with an ellipsis", () => {
    const long = "word ".repeat(100).trim();
    const out = firstParagraph(long, 40);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out.endsWith("…")).toBe(true);
  });

  it("returns empty for missing, empty, or heading-only content", () => {
    expect(firstParagraph(undefined)).toBe("");
    expect(firstParagraph("")).toBe("");
    expect(firstParagraph("# Only a heading")).toBe("");
  });
});
