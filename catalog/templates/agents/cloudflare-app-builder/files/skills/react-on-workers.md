---
description: Use when building, changing, shipping, or debugging a React web app that runs on Cloudflare Workers — the scaffold command, project layout, wrangler.jsonc semantics, the verify workflow, and the SPA-vs-Worker routing rules.
---

# React on Cloudflare Workers

One project, two halves: a React + Vite single-page app served as static assets,
and a Worker that is the API backend. Cloudflare's Vite plugin runs the Worker
locally under the same conditions as production, so what works in dev works
deployed.

## Scaffold

```bash
npm create cloudflare@latest -- <app-name> --framework=react --no-deploy --git=false
```

Run it non-interactively (`CI=true` in the environment helps), with a kebab-case
app name. `--no-deploy` matters: deploying is a separate, deliberate step, never
a side effect of scaffolding. The generated project:

| Path | What it is |
|---|---|
| `src/App.tsx` | The React SPA. Talks to the backend with `fetch("/api/...")`. |
| `worker/index.ts` | The Worker — the API backend, and the only code that can use bindings. |
| `index.html` | SPA entry point. |
| `vite.config.ts` | Vite + the Cloudflare plugin (local Worker emulation, HMR). |
| `wrangler.jsonc` | Worker config: `main` points at `worker/index.ts`; assets serve the built SPA. |

## The two routing rules

1. `wrangler.jsonc` sets `assets.not_found_handling: "single-page-application"`:
   unmatched paths return `index.html`, so client-side routes work on refresh
   and never invoke (or bill) the Worker. Leave it that way.
2. The Worker handles only `/api/*` (see the generated `worker/index.ts`). Add
   backend endpoints there; add pages in React. Never serve pages from the
   Worker and never import bindings into `src/` — React reaches compute,
   storage, and AI only through `fetch()` to the Worker.

## Verify, then ship

All commands run in the app directory.

```bash
npm install --no-audit --no-fund   # once, or after dependency changes
npm run build                      # production build — run after changes, ALWAYS before pushing
```

A clean `npm run build` is your definition of shippable: the deploy downstream
runs the same build, so what passes here won't die in the build step there. You
do not deploy — that happens after your PR merges, with credentials you don't
have or need. On a build failure, read the last lines of the output — that's
the actual error — fix, and re-verify before pushing.

For local development with hot reload (a human at a browser): `npm run dev`.

## Bindings (KV, D1, R2, AI, …)

Declare the binding in `wrangler.jsonc`, use it from `worker/index.ts` via
`env.<BINDING>`, and expose it to the UI as an `/api/...` route. The Vite plugin
emulates bindings locally in dev. Regenerate Worker types after adding one so
`env` stays typed:

```bash
npx wrangler types
```
