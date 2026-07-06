---
description: How eve agents are structured in an Eden repo — where tools, skills, schedules, sandboxes, and dependencies live, and the conventions to match when authoring them.
---

# Building eve agents in an Eden repo

A member's eve project lives under a root (`agent/` for a single-agent repo, or
`agents/<member>/agent/` for a team member). The layout by convention:

- `<root>/agent.ts` — `defineAgent({ model, ... })` from `"eve"`. The entrypoint.
- `<root>/instructions.md` — the always-on system prompt (Markdown).
- `<root>/tools/<name>.ts` — one `defineTool` per file, default-exported, from `"eve/tools"`.
  `inputSchema` is a zod object; describe every field; `execute()` returns JSON-serializable data
  and handles failure paths (non-2xx responses, missing data) with useful error shapes.
- `<root>/lib/<name>.ts` — shared helpers imported by tools via a relative path.
- `<root>/skills/<name>.md` — YAML frontmatter `description:` + Markdown; progressive-disclosure
  knowledge the model loads on demand.
- `<root>/schedules/<name>.md` — YAML frontmatter `cron:`; the body is the message delivered to
  the agent when the schedule fires. Schedules run inside the always-on instance.
- `<root>/sandbox.ts` — one `defineSandbox` from `"eve/sandbox"`, defining the isolated shell the
  agent's bash/file tools run in. `bootstrap()` preinstalls CLIs once (snapshotted).

## Rules that keep an agent deployable

- Secrets are `process.env.NAME`, SCREAMING_SNAKE_CASE, never hardcoded. The human sets values
  on Eden's Secrets page; they're injected at deploy time.
- Dependencies change ONLY through `eden_add_dependency` (regenerates the lockfile). Prefer
  `fetch()` + Node built-ins first.
- The sandbox shell is sealed: it only sees secret names in the `EDEN_SANDBOX_ENV` allowlist.
  Preserve that block when editing an existing `sandbox.ts`.
- Keep tools small and single-purpose; the model chooses a tool by reading its `description`, so
  make descriptions precise.

## The Eden workflow

Everything Eden's assistant writes is a STAGED DRAFT — reviewed on the Changes tab, published as a
pull request, merged, then deployed as an immutable release. Nothing reaches the running agent
until it is merged and deployed.
