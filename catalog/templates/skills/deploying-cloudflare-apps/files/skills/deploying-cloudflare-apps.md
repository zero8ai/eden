---
description: Use when deploying an app to Cloudflare and provisioning the resources it needs — wrangler config and deploys, KV/D1/R2/Queues/Pages, dry-runs, and getting deploy credentials into a CI pipeline. Cloudflare only; getting the code (GitHub, GitLab, an archive) and wiring a specific forge's pipeline file are separate skills.
---

# Deploying to Cloudflare

Deploy applications to Cloudflare and provision what they need, from the terminal, with `wrangler` and the Cloudflare API when Wrangler doesn't cover an operation. This is about Cloudflare only: getting the code — from GitHub, GitLab, an archive, wherever — and wiring a particular CI system's pipeline file are separate skills. Assume the code is already in the working tree.

## Auth

`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are in the environment. The token is scoped to the target account with the product permissions the app uses — Workers, plus KV, D1, R2, Queues, Pages, Routes, DNS, AI, Vectorize as required. Confirm `wrangler whoami` works before starting, and prefer the repo's pinned Wrangler (`npx wrangler`) over a global one. If a credential is missing or Wrangler cannot authenticate, stop and say so — don't guess. Never print tokens.

## Inspect first

Read `package.json`, the `wrangler` config, framework config, and any source that references bindings. Work out the build command, the deploy command, the Worker name, the environments, and which Cloudflare products the app actually uses.

## Provision what the app needs

Create the resources the config declares or clearly requires — KV namespaces, D1 databases, R2 buckets, queues, Pages projects, routes. List existing resources first and reuse a clear match rather than creating duplicates. When a resource yields an ID or binding the app needs, write it back into the committed `wrangler` config — that config is the source of truth. Read D1 migration files before applying them, and ask before anything destructive or that touches production data.

## Deploy credentials into CI

A pipeline deploys with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` set as secrets in the CI system — never committed to the repo. How you set a secret and where the pipeline file lives depend on the forge, and that is its own skill; the rule here is only that these two values reach the runner as environment secrets, by name, with nothing sensitive echoed.

## Verify, then deploy

Run the repo's install and checks, then `wrangler deploy --dry-run` before any real deploy — the dry-run catches config and binding errors without shipping. Deploy to a staging environment first when one exists. Use least privilege, and pin versions. If a production deploy is ambiguous or risky, stop and report exactly what is ready and the command to run.

## Boundaries

Ask before deleting or renaming Cloudflare resources, running destructive D1 migrations or touching data, changing DNS, custom domains, or production routes, or creating paid resources of unclear cost. Routine non-destructive resource creation, dry-runs, and staging deploys the user asked for need no permission. Don't print or commit secrets, or write pipelines that echo them — confirm setup by listing secret names only.
