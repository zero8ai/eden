---
description: Use when working a GitHub repository from the terminal — authenticating gh, finding the right repo, branching and pushing, opening and updating pull requests, reviewing and merging, and storing CI secrets and workflow files. This is GitHub mechanics; what a change or a pipeline actually does comes from the task and other skills.
---

# GitHub

Work GitHub from the terminal with `gh` and `git`. The credential is **the agent's own GitHub App** — `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` in the environment (they arrive with the agent's GitHub channel; `GITHUB_APP_SLUG` is the app's @name). Mint a short-lived installation access token: sign a RS256 JWT as the app, find the installation (the app's only one, or the one covering the target repo), then `POST /app/installations/{id}/access_tokens`. Export the result as `GH_TOKEN` for `gh`; for git-over-HTTPS use it as the password with username `x-access-token`. Tokens expire after an hour — re-mint instead of persisting. Work is attributed to the app's bot identity, and the repositories the token can reach are exactly the ones the app is installed on: that is the agent's scope.

If the app credentials are missing or the first GitHub call fails, stop and tell the user (the agent's GitHub channel setup provides them) rather than guessing. Never print a token or ask for one in chat.

## Find the repository

Use the repo named by the user or implied by the issue context. If it isn't clear, discover what the credential can reach — the app installations' repository lists; given an owner but not a repo, list that owner's repos. If an issue number could belong to more than one repo, search the likely ones and act only on a single clear match — otherwise ask.

Clone the repo, or fetch and reset to the remote if you already have it, and start from a fresh default branch unless the task names another ref.

## Branch and push

Make changes on a feature branch off the default branch, never on it directly. Keep each commit a focused, coherent step. Push the branch to open a pull request; push more commits to the same branch to update one — don't open a second PR for the same work.

## Pull requests

Open PRs with `gh pr create`. Write a title and body that explain the change and link the issue it addresses — use a closing keyword (`Closes #123`) only when the PR fully resolves the issue, never for partial work. Request the reviewer the task names. After opening, comment the PR URL back on the issue with what was done and anything a human needs to verify.

## Review and merge

Inspect state with `gh` — assigned issues, linked PRs, comments, reviews, checks, and mergeability. Merge only when the required approvals are in and checks pass, using a merge method the repo allows, and never bypass branch protection. If a review requests changes, update the same branch, rerun checks, push, and comment what changed.

## CI secrets and workflows

When a pipeline needs credentials, put them in Actions secrets with `gh secret set` — by name, never committing or echoing the values — and add or edit workflows under `.github/workflows/`. Use least-privilege `permissions:` and pin action major versions. What the pipeline *builds and deploys* comes from the relevant capability skill; this is only how GitHub stores secrets and runs workflows.

## Boundaries

Don't commit secrets, print secrets (the private key included), or write workflows that echo them — confirm setup by listing secret names only. Ask before pushing directly to a default or protected branch, merging without the required approvals, or manually closing an unmerged issue.
