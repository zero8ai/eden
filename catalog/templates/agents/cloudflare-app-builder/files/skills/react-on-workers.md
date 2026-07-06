---
description: Use when building, changing, shipping, or debugging a React web app that runs on Cloudflare Workers — how to choose the right Cloudflare scaffold, project layout, wrangler.jsonc semantics, the verify workflow, and the SPA-vs-Worker routing rules.
---

# React on Cloudflare Workers

One project, two halves: a React + Vite single-page app served as static assets,
and a Worker that is the API backend. Cloudflare's Vite plugin runs the Worker
locally under the same conditions as production, so what works in dev works
deployed.

## Choose the scaffold

Start from Cloudflare's current docs and generator, not memory. The common
full-stack React SPA + Worker API path is:

```bash
npm create cloudflare@latest -- <app-name> --framework=react
```

Useful docs:

- React + Vite on Workers:
  `https://developers.cloudflare.com/workers/framework-guides/web-apps/react/`
- C3 CLI arguments:
  `https://developers.cloudflare.com/pages/get-started/c3/`
- Cloudflare Vite plugin:
  `https://developers.cloudflare.com/workers/vite-plugin/`

Choose the path for the task:

- **React SPA with a Worker API:** use the React framework guide above. This is
  the default for product apps, dashboards, forms, and tools with a browser UI.
- **Standalone API Worker:** use a Worker starter instead; do not force React
  when the user only needs an API, webhook, cron, queue consumer, or proxy.
- **SSR or router framework:** use the relevant Cloudflare framework guide
  (React Router, TanStack Start, Hono, Astro, etc.) if the task calls for it.
- **Existing app:** inspect its current framework and Wrangler/Vite config
  first. Adapt it with the official docs instead of replacing its structure.

For agent-created projects, avoid deployment and nested git initialization when
the generator offers those switches (`--no-deploy`, `--git=false`, or current
equivalents). If prompts appear, answer them according to the scenario. Do not
use `--accept-defaults` as a substitute for choosing the right category,
framework, platform, or variant.

For the React SPA + Worker API scaffold, the generated project should look like:

| Path | What it is |
|---|---|
| `src/App.tsx` | The React SPA. Talks to the backend with `fetch("/api/...")`. |
| `worker/index.ts` | The Worker — the API backend, and the only code that can use bindings. |
| `index.html` | SPA entry point. |
| `vite.config.ts` | Vite + the Cloudflare plugin (local Worker emulation, HMR). |
| `wrangler.jsonc` | Worker config: `main` points at `worker/index.ts`; assets serve the built SPA. |

Immediately validate the scaffold before writing application code:

```bash
test -f vite.config.ts
test -f wrangler.jsonc
test -f worker/index.ts
test -f src/App.tsx
node -e 'const p=require("./package.json"); for (const d of ["react","react-dom","vite","@cloudflare/vite-plugin"]) if(!JSON.stringify(p).includes(d)) throw new Error(`missing ${d}`)'
```

If the scaffold does not match the selected scenario, stop and correct the
scaffold. Delete the bad output and retry the official generator once with the
right prompt answers or CLI arguments. Only reconstruct files manually when the
official generator is unreachable or repeatedly broken, and say that clearly in
the final report.

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
