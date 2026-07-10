---
description: Use when calling GitHub (gh or git) with the agent's GitHub App credentials — exchanging the App's private key for a short-lived installation token. Credential mechanics only; what to actually do on GitHub comes from the task.
---

# GitHub App auth

The credential is **the agent's own GitHub App** — `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` in the environment (they arrive with the agent's GitHub channel; `GITHUB_APP_SLUG` is the app's @name). GitHub never accepts the private key directly: mint a short-lived installation access token from it — sign an RS256 JWT as the app, find the installation (the app's only one, or the one covering the target repo), then `POST /app/installations/{id}/access_tokens`. Export the result as `GH_TOKEN` for `gh`; for git-over-HTTPS use it as the password with username `x-access-token`. Tokens expire after about an hour — re-mint instead of persisting. Work is attributed to the app's bot identity, and the repositories the token can reach are exactly the ones the app is installed on: that is the agent's scope.

Git commits are only attributed to the app if the author matches its bot account — never invent a `user.name`/`user.email`, and set both before the first commit:

```bash
git config user.name  "${GITHUB_APP_SLUG}[bot]"
git config user.email "$(gh api "/users/${GITHUB_APP_SLUG}%5Bbot%5D" --jq .id)+${GITHUB_APP_SLUG}[bot]@users.noreply.github.com"
```

A made-up author email maps to no GitHub account, which leaves commits unattributed and makes git-connected deploy platforms (e.g. Vercel) reject the push outright; the bot identity is exempt from those checks.

If the app credentials are missing or the first GitHub call fails, stop and tell the user (the agent's GitHub channel setup provides them) rather than guessing. Never print a token or the private key, and never ask for a personal access token in chat.
