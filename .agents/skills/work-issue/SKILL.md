---
name: work-issue
disable-model-invocation: true
description: >
  Take a GitHub issue to a review-ready PR: read it, implement it, verify in a browser,
  open a PR, and iterate on CI feedback until it's clean.
---

# work-issue

Take the given GitHub issue from problem statement to a PR that's ready for me to merge.

The workflow:

1. **Research (main agent).** Read the issue and its comments. Research the codebase enough to
   implement it well and match existing patterns. Produce a concrete implementation plan.
2. **Implement (Opus sub-agent).** Hand the full plan to an Opus sub-agent, which writes the code
   and tests, runs the tests, browser-verifies, and opens the PR (see model split below).
3. If the change surfaces in the UI, the implementing sub-agent verifies it end-to-end in a
   browser **using the `agent-browser` skill** — never the built-in browser tools. Exercise the
   actual flow from the issue and capture screenshots.
4. The PR targets `main` and is linked to the issue.
5. Wait for CI to finish. Address any failures; every push re-triggers it. Repeat until CI is
   green.
6. **Verify (main agent).** Review the sub-agent's work against the research and plan (see below).
7. Hand me the finished PR with a summary and the screenshots. Don't merge.

## Model split

**Codex coding harness override:** When this skill runs in Codex, ignore all Opus, Fable, and
model-selection directions below. Use whatever agent and model the coding harness provides for the
entire workflow; do not request or select a different model. Sub-agents may still be used when the
harness supports them, but never to enforce a model split.

**Research and planning stay with the main agent**, on whatever model the session is set to.
The main agent reads the issue, explores the codebase, and writes the implementation plan — it is
the only party that does research.

**Everything after planning is done by sub-agents running Opus** (`model: opus`):

- writing the product code and tests, and running the tests
- browser verification via `agent-browser` and capturing screenshots
- opening the PR, watching CI, and shepherding it until green
- routine PR management (rebases, comment replies, re-pushes)

If CI or verification reveals a real code problem, the fix is also done by an Opus sub-agent —
the main agent updates the plan if needed and hands the fix off; it does not write the code itself.

## Plan handoff

The sub-agent must never re-research what the main agent already learned. The prompt passed to the
implementing sub-agent must be self-contained and include:

- the issue number, title, and a summary of the problem and any decisions from its comments
- the implementation plan: exact files to touch (paths), what to change in each, and the order
- the codebase patterns/conventions to follow, with pointers to example files
- how to test: which tests to add/update, how to run them, and the browser flow to verify
- PR requirements: target `main`, link the issue, don't merge

## Verification by the main agent

After the sub-agent finishes, the main agent reviews the result before handing it over:

- read the actual diff and confirm the implementation matches the plan and the research —
  right files, right approach, follows the patterns identified during research
- confirm nothing from the plan was skipped or silently changed; if the sub-agent deviated,
  either accept the deviation explicitly (if it's an improvement) or send it back with a
  corrected, self-contained prompt
- confirm tests exist, pass, and cover what the plan called for, and that CI is green

The main agent verifies; it does not rewrite. Fixes go back to an Opus sub-agent with an updated
plan.
