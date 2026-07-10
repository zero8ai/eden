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

Authentication is local Better Auth email/password. There is no hosted-provider
login and no session-minting helper: create a disposable user through `/signup`
on a fresh worktree DB, or sign in through `/login`. Use a named browser session
so cookies persist between commands:

```bash
agent-browser --session eden-<branch> open "http://localhost:<PORT>/signup"
agent-browser --session eden-<branch> snapshot -i
# Fill the name/email/password fields from the snapshot, submit, then wait for /dashboard.
agent-browser --session eden-<branch> wait --url "**/dashboard"
agent-browser --session eden-<branch> open "http://localhost:<PORT>/repos/<id>/deployment"
```

The login deliberately has two screens: fill email and submit `Continue`, take a fresh snapshot,
then fill password and submit `Sign in`. The first step must not make an auth request. For reset
testing, configure `SMTP_URL` and `FROM_EMAIL`, request from `/forgot-password`, follow the Better
Auth callback URL captured by the local inbox, and verify the consumed link cannot be reused.

For a reusable file, run
`agent-browser --session eden-<branch> state save /tmp/eden-auth.json` after sign-in. Later, open
with `agent-browser --state /tmp/eden-auth.json ...`.
State files contain live session credentials: keep them outside the repo and
delete them when verification is done.

The workspace id must match the project's `org_id`. Better Auth stores it in
`organization.id`; the current browser session stores its active value in
`session.active_organization_id`. For invitation tests use two isolated browser
sessions (`--session inviter` and `--session invitee`) and obtain the acceptance
link from the SMTP test inbox configured by `SMTP_URL`.

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
