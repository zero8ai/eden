---
name: verify
description: How to build, launch, and drive Eden for runtime verification of a change — dev server, authenticated agent-browser session, and seed-data tricks. Use when verifying that a code change works in the running app.
---

# Verifying Eden changes in the running app

## Launch

From the worktree root (per-worktree port is in `CLAUDE.local.md` / `.env.local`):

```bash
npm run dev        # background it; waits ~5s then serves http://localhost:<PORT>
```

Worktree DBs are clones taken at setup time. If any page 500s with a
`column ... does not exist` Postgres error, the clone is behind the branch's
migrations — fix with:

```bash
set -a; source .env.local; set +a; npm run db:migrate
```

`psql` isn't on PATH; Postgres runs in Docker. Query with:

```bash
docker exec eden-postgres psql -U eden -d <DB_NAME_from_.env.local> -c "..."
```

## Authenticated browser session

Login is WorkOS password-only (no Magic Auth) — don't log in interactively.
Mint a `wos-session` cookie as Playwright storage state and start agent-browser
with it (script: adapt `mint-session.mjs` from a prior session's scratchpad, or
the recipe in the user's `eden-browser-verify-auth` memory; symlink
`node_modules` into the scratchpad so its ESM imports resolve):

```bash
node mint-session.mjs --org <orgId> --out state.json
agent-browser --state state.json open "http://localhost:<PORT>/repos/<id>/deployment"
```

Org id must match the projects' `org_id` in the worktree DB (`select org_id from projects`).

## Driving & evidence

- `agent-browser snapshot -i -u` and `agent-browser eval "document.body.innerText"`
  are reliable for asserting rendered content and link hrefs.
- Physical `click` on ref often misses on pages using `useLiveRevalidate`
  (poll re-renders detach the node). Navigate via
  `agent-browser eval "...querySelector('a[...]').click()"` or `open <href>` instead.
- `agent-browser screenshot` works once per daemon, then tends to hang
  (`os error 35`). Take the screenshot you need early; on hang,
  `agent-browser close --all && pkill -f agent-browser` and reopen.

## Seed-data tricks

- A "running" env row needs a live deployment: insert a `releases` row +
  `deployments` row (`status='live'`, any `url`) for the agent's environment,
  then delete both after. IDs are 12-char varchar, any unique string works.
- The overview Ship banner renders from URL params:
  `/repos/<id>?shipped=<gitSha>&env=<envName>&skipped=<member>` — the sha must
  match a deployment row's `git_sha`.
- Roster is synced from the GitHub repo tree on page load, not the DB; check
  channel files with `gh api "repos/<owner>/<repo>/git/trees/HEAD?recursive=1"`.
