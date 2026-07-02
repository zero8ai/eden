# Spike: building & running eve headlessly (validated 2026-07-02)

Every claim below was executed for real against `eve@0.18.1` on this machine (scaffold →
build → Postgres World → containerized run → durable session). This de-risks PRD §12's
"eve beta churn" / "`eve init` in a server context" and ARCH §11's spikes #5 and #6 (partially).

## What was proven

1. **`eve init` and `eve build` are fully headless.** `npx eve@latest init <dir>` scaffolds and
   npm-installs with no TTY; `eve build` emits a standard Nitro `.output/` (node-server preset).
   Requires **Node ≥ 24** — irrelevant to Eden's control plane because our pipeline runs both
   inside `node:24-slim` build containers (see `app/deploy/eve-image.server.ts`).

2. **The Workflow World is compile-time config in the repo, not deploy-time.** The world module
   is selected in `agent/agent.ts`:

   ```ts
   export default defineAgent({
     model: "anthropic/claude-sonnet-5",
     build: { externalDependencies: ["@workflow/world-postgres"] },
     experimental: { workflow: { world: "@workflow/world-postgres" } },
   });
   ```

   - `build.externalDependencies` is required: bundling the world fails (graphile-worker →
     cosmiconfig does a dynamic `require('typescript')` that rolldown can't resolve). External
     keeps it in `server/node_modules` of the traced output, which works.
   - **Consequence for Eden:** a customer repo is only deployable off-Vercel if it declares the
     world dep + config. Connect should validate this and offer a **"make deployable" PR**
     (fits the git-native model) that adds the dependency and patches `agent.ts`.

3. **Version coupling is strict and runtime-enforced.** eve 0.18.1 ships `@workflow/*
   5.0.0-beta.x`; the *stable* `@workflow/world-postgres@4.2.0` is rejected at runtime
   ("World that supports spec version 4 or later" — world spec versions are checked per
   feature). The matching line is `@workflow/world-postgres@5.0.0-beta.20`. Eden must treat
   (eve version ↔ world version) as a pinned pair per repo; surface a clear error when they drift.

4. **Runtime env contract of the built server:**
   - `WORKFLOW_POSTGRES_URL` — the Postgres World connection string (the world's `createWorld`
     reads this; `DATABASE_URL` is *not* read by the world). One database per instance.
   - `PORT` — Nitro listen port.
   - Model calls default to **Vercel AI Gateway** (`https://ai-gateway.vercel.sh/v4/ai`) even
     off-Vercel: provider-prefixed model strings need `AI_GATEWAY_API_KEY` (or `VERCEL_OIDC_TOKEN`
     via `eve link`). There is **no env override for the gateway base URL** in the bundle —
     intercepting model traffic (managed ModelGateway, ARCH §3.2) therefore requires either
     (a) per-instance `AI_GATEWAY_API_KEY` secrets (v1: BYO key as a project secret), or
     (b) authoring an AI-SDK provider model in `agent.ts` (later; needed for our own proxy).

5. **Schema migrations are a separate, required step.** `@workflow/world-postgres` ships a
   `workflow-postgres-setup` CLI (drizzle migrations + graphile-worker bootstrap). It must run
   once per instance database **before** the server handles a session. The CLI and SQL files
   are NOT traced into `.output/` — hence the deploy pipeline keeps the Docker **build stage**
   image (full node_modules) and runs setup from it:
   `docker run --rm -e WORKFLOW_POSTGRES_URL=… <image>-build node node_modules/@workflow/world-postgres/bin/setup.js`

6. **The multi-stage Dockerfile works** (see `EDEN_EVE_DOCKERFILE` in eve-image.server.ts):
   `npm ci` + `eve build` inside `node:24-slim` (native modules traced for linux, not the host),
   runtime stage = `.output/` only. The containerized agent, pointed at the host Postgres via
   `host.docker.internal`, accepted durable sessions.

7. **HTTP contract confirmed:** `POST /eve/v1/session {"message": …}` → `202` with
   `x-eve-session-id` header and `{sessionId, continuationToken, ok}`;
   `GET /eve/v1/session/:id/stream` is a typed JSON event stream:
   `session.started → turn.started → message.received → step.started → step.completed/failed →
   turn.completed/failed → session.*` — with model id, tokens/timing metadata, and error
   payloads (`code: MODEL_CALL_FAILED`, provider status) on failures.

8. **The observability source of truth is richer than expected** (ARCH §11 spike #6):
   the World's Postgres schema (`workflow.workflow_runs/_steps/_events/_hooks/_stream_chunks`)
   records sessions and turns as runs with attributes
   `{"$eve.type": "session"|"turn", "$eve.parent", "$eve.root", "$eve.trigger", "$eve.title"}`
   plus a full event log (`run_created/started/completed`, `step_*`, `hook_*`).
   **Design consequence:** for managed/local instances Eden provisioned the DB itself, so the
   runs-store ingester can read the event log **directly from the instance database** — no OTLP
   hop needed for v1. The authenticated OTLP/ingest endpoint remains the BYO path.

## Update 2026-07-02 (later): real model turns verified via OpenRouter

With `OPENROUTER_API_KEY` (in .env.local) and the OpenRouter provider wiring
(docs/RESEARCH-OPENROUTER.md), a **real turn completed end-to-end on the host**: POST session →
queue → flow → OpenRouter (claude-sonnet-4.5) → `message.completed: "pineapple"`, all durable
state in the Postgres World. Follow-up note: POSTing with `continuationToken` returned a NEW
session id and the reply lacked prior context — the multi-turn continuation contract needs
study before Eden's chat UI relies on it.

**Open issue — queue execution inside Docker:** the same image serves HTTP, reaches Postgres
and openrouter.ai, and creates sessions, but the *flow jobs* (graphile-worker → self-POST
`/.well-known/workflow/v1/flow`) die with a bare `TypeError: fetch failed` (no cause surfaced).
Eliminated: base URL resolution (PORT/`WORKFLOW_LOCAL_BASE_URL` both correct; manual fetch of
the exact URL+headers from inside the container succeeds), node/undici version skew (host and
image both v24.18.0/undici 7.28.0), WASM SIMD (`UNDICI_NO_WASM_SIMD=1` no effect). One flow
fetch was observed succeeding under `NODE_DEBUG=fetch` (session → running) while the turn's
job still failed silently via a *bundled* undici copy. Next steps: test non-slim base image,
then minimal repro against the eve/workflow repos (likely upstream bug report). Dev flow is
not blocked (host runs work); containerized instance turns are blocked on this.

## Still open (needs credentials / later work)
- **OTel span fidelity** (`agent/instrumentation.ts`) — not yet exercised; less urgent now that
  the event log covers structure, but still wanted for token/latency detail.
- **Gateway interception** for managed metering (point instances at our proxy) — blocked on
  (b) in finding 4.
- Tarball fetch in `buildEveImage` is code-complete but needs the registered GitHub App to run.

## Spike artifacts

Scratch project (not in this repo): `spike-agent` under the session scratchpad; spike database
`eden_spike` on the local compose Postgres (safe to drop).
