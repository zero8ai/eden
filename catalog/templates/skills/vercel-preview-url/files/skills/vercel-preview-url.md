---
description: Use when a pull request needs its Vercel preview deployment URL — read it from the vercel[bot] comment on the PR with the agent's GitHub credentials. No Vercel access exists or is needed; never ask for a Vercel token.
---

# Vercel preview URL

When a repository is connected to Vercel through its GitHub integration, every push to a PR
branch gets a preview deployment, and Vercel's bot comments the URL on the PR. Reading that
comment is the whole mechanism — authenticate with the agent's GitHub App token (see the
GitHub App auth skill) and poll the PR's comments until the link appears:

```bash
# REPO like owner/name, PR the number. Builds take a few minutes — poll, don't one-shot.
for i in $(seq 1 20); do
  url=$(gh api "repos/$REPO/issues/$PR/comments" \
    --jq '[.[] | select(.user.login == "vercel[bot]")] | last.body' |
    grep -oE 'https://[a-z0-9.-]+\.vercel\.app' | head -1)
  [ -n "$url" ] && break
  sleep 15
done
```

Vercel edits its comment in place as newer commits deploy, so the latest `vercel[bot]`
comment always reflects the newest build. The preview URL is the `*.vercel.app` link (the
`vercel.com/...` links in the same comment are the build's dashboard pages — not it).
Vercel also exposes a stable per-branch alias of the form
`https://<project>-git-<branch>-<team>.vercel.app` (branch lowercased, `/` → `-`); if you
construct one as a shortcut, curl it for a non-error status before handing it to anyone.

Failure modes — both end with telling the user, never with asking for Vercel credentials:

- **The vercel[bot] comment says the author "must be a member of the team" to deploy.**
  Vercel only builds commits whose author it recognizes; commits authored as the agent's
  own `<slug>[bot]` identity count as properly-identified bot commits and deploy without a
  Vercel seat. Check `git config user.name` / `user.email` against the GitHub App auth
  skill's attribution rules — never invent an author. If attribution is correct and the
  block persists, stop: a human must authorize the deployment on Vercel.
- **No vercel[bot] comment after ~5 minutes.** The repository isn't connected to a Vercel
  project, or PR comments are disabled in the Vercel project's Git settings. Stop and tell
  the user what's missing.
