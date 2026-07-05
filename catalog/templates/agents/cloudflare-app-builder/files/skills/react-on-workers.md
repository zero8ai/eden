---
description: Use when building, changing, or debugging a React web app that runs on Cloudflare Workers — project layout, wrangler.jsonc semantics, the dev/build/deploy commands, and the SPA-vs-Worker routing rules.
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

(The `scaffold-app` tool runs exactly this.) The generated project:

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

## Commands

```bash
npm run dev      # Vite dev server + local Worker emulation, HMR
npm run build    # production build (what check-app runs after install)
npm run deploy   # build + wrangler deploy → *.workers.dev or a custom domain
```

## Bindings (KV, D1, R2, AI, …)

Declare the binding in `wrangler.jsonc`, use it from `worker/index.ts` via
`env.<BINDING>`, and expose it to the UI as an `/api/...` route. The Vite plugin
emulates bindings locally in dev. Regenerate Worker types after adding one so
`env` stays typed:

```bash
npx wrangler types
```
