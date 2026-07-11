---
description: Use when calling GitHub (gh or git) with the agent's GitHub App credentials — minting a short-lived installation token AND assuming the App's bot identity for commits. Credential mechanics only; what to actually do on GitHub comes from the task.
---

# GitHub App auth

The credential is **the agent's own GitHub App** — `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`
in the environment (they arrive with the agent's GitHub channel; `GITHUB_APP_SLUG` is the
app's @name). Using it is always the same two steps, in this order, before any other git or
GitHub work:

**1. Mint a token.** GitHub never accepts the private key directly: sign an RS256 JWT as the
app, find the installation (the app's only one, or the one covering the target repo), then
`POST /app/installations/{id}/access_tokens`. Export the result as `GH_TOKEN` for `gh`; for
git-over-HTTPS use it as the password with username `x-access-token`. Tokens expire after
about an hour — re-mint instead of persisting. The repositories the token can reach are
exactly the ones the app is installed on: that is the agent's scope.

**2. Assume the credential's identity.** You are acting as the App, so commits must be
authored as its bot account — an identity *derived from the credential*, never chosen.
Immediately after minting the token, before the first commit, run exactly:

```bash
git config --global user.name  "${GITHUB_APP_SLUG}[bot]"
git config --global user.email "$(gh api "/users/${GITHUB_APP_SLUG}%5Bbot%5D" --jq .id)+${GITHUB_APP_SLUG}[bot]@users.noreply.github.com"
```

(`--global` so every repo cloned this session inherits it — per-repo config gets forgotten.)

Never substitute anything else for this identity: not a name you make up, not the human
user's name or email, not an address seen in the repo's commit history, not a placeholder.
GitHub attributes commits by exact email match, so any other value leaves the work
unattributed — and git-connected deploy platforms (Vercel and friends) refuse to build
commits whose author they can't recognize, which silently kills PR preview deployments. The
bot identity passes those checks precisely because it is the credential's own. If
`GITHUB_APP_SLUG` is missing or the id lookup fails, stop and tell the user — do not commit
with a guessed identity.

If the app credentials are missing or the first GitHub call fails, stop and tell the user
(the agent's GitHub channel setup provides them) rather than guessing. Never print a token
or the private key, and never ask for a personal access token in chat.
