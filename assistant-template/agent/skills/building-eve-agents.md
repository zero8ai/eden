---
description: Where to find eve's authoring conventions (the official docs) and the Eden-specific rules layered on top when building tools, skills, schedules, sandboxes, and dependencies in a connected repo.
---

# Building eve agents in an Eden repo

eve is filesystem-first: under an agent's root, the directory a file lives in determines what it is, and identity comes from the path (never a `name`/`id` field). A member's root is `agent/` (single-agent repo) or `agents/<member>/agent/` (team member).

Consult the eve docs for the framework conventions before authoring — they're the source of truth and stay current with the installed version:

- Project layout & the path-naming rule: https://eve.dev/docs/reference/project-layout
- Tools: https://eve.dev/docs/tools · Skills: https://eve.dev/docs/skills · Schedules: https://eve.dev/docs/schedules
- Sandbox: https://eve.dev/docs/sandbox · Connections: https://eve.dev/docs/connections · Subagents: https://eve.dev/docs/subagents · Channels: https://eve.dev/docs/channels/overview
- `agent.ts`: https://eve.dev/docs/agent-config · `define*` reference: https://eve.dev/docs/reference/typescript-api

## Eden's rules on top of the framework

- Secrets are `process.env.NAME`, `SCREAMING_SNAKE_CASE`, never hardcoded. The human sets values on Eden's Secrets page; Eden injects them at deploy time. The sandbox shell is sealed — it only sees names in the `EDEN_SANDBOX_ENV` allowlist, so preserve that block when editing an existing `sandbox.ts`.
- Prefer `fetch()` + Node built-ins first — most integrations are one HTTPS call. When a dependency is justified, run `npm install <pkg>` in the correct agent project so its manifest and lockfile change together; never hand-edit the lockfile.
- Keep tools small and single-purpose, and handle failure paths with useful error shapes; the model picks a tool by reading its `description`, so make descriptions precise.
- Ground every plan or change in `eden_project_context` and the actual git checkout. Make changes in that checkout and use its native npm scripts and `npx eve` commands for verification.
- For create/build/change/fix requests, follow the `plan-implement-validate` skill through implementation and behavioral checks. A compilation-only check is not enough when the requested behavior can be exercised with evals, skill-load assertions, schedule dispatch, or a running instance.
