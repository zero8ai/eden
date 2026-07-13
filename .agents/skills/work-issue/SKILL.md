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

## Unattended mode (orchestrated runs)

This section applies ONLY when the invoking prompt says the run is unattended/orchestrated.
There is no human at the keyboard: never ask a question, never pause for input, and never
guess on a decision that materially affects the implementation.

**Preflight gate.** After the research step (issue + comments read, codebase explored), decide
whether the issue is actionable. **A blocker is an unmade decision — nothing else.** The issue
is NOT actionable only when:

- an open decision in the issue or its comments changes what gets built
- the issue is ambiguous enough that two reasonable implementations would differ materially
  (which is the same thing: a decision nobody has made yet)

When it's not actionable, stop before writing any code, post the exact blocking questions as a
comment on the issue (`gh issue comment <nr>`), and end the run. Phrase each question so a
yes/no or short answer suffices. Minor judgment calls that any implementation would share are
NOT blockers — decide them and note the decision in the PR description.

**Missing credentials, env vars, or external services are NOT blockers — build the feature
anyway:**

- if a value can be made up (a local-only secret, a placeholder URL, a key the code merely
  reads), make it up and note it in the PR description
- if a flow genuinely can't be exercised without real external setup (a GitHub App,
  third-party API credentials), build it, test everything that IS reachable, and list the
  rest in the PR description under **Not verified** — "built but not verified end-to-end" is
  a finished run, not a blocked one

**Deliverable.** An actionable issue ends as a PR to `main`, linked to the issue, not merged.
The PR description is the single place the outcome lives — write it for someone who hasn't seen
the issue. It must include:

- **Summary** — what was built, plus any decisions or made-up values you settled during the run.
- **Testing** (a `## Testing` heading) — the exact flow to click through to exercise the change,
  and anything to provision first (credentials, GitHub Apps, env vars).
- **Not verified** (a `## Not verified` heading) — flows built but not exercised end-to-end, each
  with the setup a human must supply to test it. Omit the heading only when everything was verified.

Open the PR as soon as the work is committed — it's the durable record of the run, so it should
exist before the final CI shepherding, not after. Attach verification screenshots to the PR.

**Unattended adjustments to the workflow:**

- Browser verification: sign up a disposable user through the app's own email/password
  sign-up (e.g. `issue-<nr>-verify@example.dev`); sign-up logs straight in — no email
  verification gate. The worktree has its own database, so this pollutes nothing.
- CI: keep pushing fixes until CI is green; every push re-triggers it. If it stays red after
  several fix cycles, leave the current diagnosis in a PR comment so the state is visible, and
  end the run.
- If a broken base branch or a missing service makes progress impossible, commit whatever is
  done, capture the diagnosis in the PR description (or an issue comment if there's no PR yet),
  and end the run — don't wait, don't work around it destructively.

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
