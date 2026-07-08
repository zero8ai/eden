---
name: work-issue
disable-model-invocation: true
description: >
  Take a GitHub issue to a review-ready PR: read it, implement it, verify in a browser,
  open a PR, and iterate on CI + Greptile feedback until it's clean.
---

# work-issue

Take the given GitHub issue from problem statement to a PR that's ready for me to merge.

The workflow:

1. Read the issue and its comments. Research the codebase enough to implement it well and match
   existing patterns.
2. Verify it end-to-end in a browser **using the `agent-browser` skill** — never the built-in
   browser tools. Exercise the actual flow from the issue and capture screenshots of anything
   that surfaces in the UI.
3. Open a PR against `main`, linked to the issue.
4. Wait for CI and the Greptile review to finish. Address the feedback — fix what's right, push
   back on what isn't. Every push re-triggers both; repeat until CI is green and Greptile has no
   outstanding issues.
5. Hand me the finished PR with a summary and the screenshots. Don't merge.
