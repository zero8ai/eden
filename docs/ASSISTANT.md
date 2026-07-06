# The Assistant: a durable, Eve-backed internal agent

Status: implemented (assistant-eve-agent branch). This document is the design of record.
It supersedes the bespoke in-process authoring loop (`app/assistant/agent.server.ts` +
`app/assistant/method.ts`, both removed).

## 1. What changed and why

Eden's authoring assistant used to be a hand-rolled OpenRouter chat-completions loop that ran
**inside a React Router action** (`await runAuthoringAgent(...)`): a blocking HTTP request, no
streaming, transcript saved only on completion. A reload mid-run orphaned the work.

The assistant is now a **real eve agent** — the same substrate every user agent runs on:

- defined as an eve project bundled in this repo (`assistant-template/`),
- deployed as its own per-project eve instance (Docker container) via the normal
  `DeployTarget`,
- driven over eve's durable HTTP session API (`app/agent/talk.server.ts`),
- streamed to the browser with a detached, reload-survivable turn loop,
- configurable by the user through repo files under `.eden/assistant/**`,
- capable of scheduled runs (schedules run in-instance, like any eve agent).

It is a **project/team-level** surface ("Assistant" is a top-level repo section), NOT a
per-agent tab and NOT a roster member. One assistant per project; it targets any member
through conversation and can scaffold the first member from an empty repo.

## 2. Eve discovery semantics — VERIFIED (build-time, not runtime)

**Finding (empirical, `eve@0.18.1`): eve discovers `instructions.md`, `skills/*.md`, and
`schedules/*.md` at BUILD time (`eve build`), not at `eve start`.**

Proof (import graph of the eve dist):
- `eve start` → `startProductionServer` (`dist/src/internal/nitro/host/start-production-server.js`)
  resolves `.output/server/index.mjs`, throws `Run "eve build" before "eve start"` if missing,
  runs `prewarmBuiltAppSandboxes`, then `spawn`s the prebuilt Nitro server. It imports **no**
  `#discover/*` module.
- `eve build` → `buildApplication` → `prepareApplicationHost` → `compileAgent` →
  `discoverAgent` (`#discover/discover-agent.js`), which globs `instructions.md`, `skills/`,
  `schedules/`. The result is baked into `.output` as a compiled manifest.
- The runtime (`dist/src/runtime/loaders/manifest.js`) reads that compiled manifest — never the
  source. Only `eve dev` watches source files (dev-only hot reload).

**Consequence for the design:** the container **entrypoint materializes the user layer, then
runs `eve build`, then `eve start`.** Restarting the same container (`eve start` only) keeps
serving the previously-compiled manifest, so config changes need a rebuild — which the
entrypoint does at every boot when a user layer is present.

This is a **boot-time rebuild inside a shared image**, not a per-project CI image build. The
runtime stage of the eve image is `FROM build` (full source tree + node_modules + `.output`),
so `node_modules/.bin/eve build` is runnable at container start. When the bundle carries no
user layer (fresh repo), the entrypoint skips the rebuild and boots the pre-compiled fixed
layer directly (fast path). We did NOT need the per-project-image fallback the spec allowed.

## 3. Data model

- `agents.kind` (`'member' | 'assistant'`, default `'member'`; migration
  `drizzle/0022_tense_romulus.sql`). Every tree-detected row is a `member`; the assistant row
  is the only `assistant`.
- Assistant row: `{ projectId, name: "assistant", root: ".eden/assistant", kind: "assistant" }`,
  created lazily on first assistant use (`ensureAssistantAgent`).
- It reuses `environments` / `releases` / `deployments` unchanged. An internal environment
  named `assistant` holds its deployment; a synthesized `Release` per template content-hash
  (`gitSha` = `sha256(bundled template)` prefixed `tmpl-`, NOT a repo commit; nothing
  dereferences it against GitHub because the assistant never builds from a tarball) binds to
  the shared `eden-assistant:<hash>` image.
- Durable threads reuse `playgroundSessions` (agentId = the assistant row). No schema addition
  was needed — the table is generic.
- Drafts attribute to the assistant row via `agentForPath` (which now sees `.eden/assistant/**`
  because the assistant row's `root` is `.eden/assistant`).

### Roster exemption & filtering

`detectAgentRoots` never yields the assistant, so `syncRoster`'s prune (`notInArray(name, …)`)
would delete it. The prune is now scoped to `kind = 'member'` (drizzle + fake store), so any
non-member row is preserved across every self-heal.

`listByProject` still returns ALL rows (drafts/`agentForPath` need the assistant row).
Filtering to members happens one layer up:
- `listAgents` (queries.server.ts) filters to `kind === 'member'` — this covers
  `resolveAgentContext`, dashboard cards, the switcher, installs, ship, secrets reconcile.
- Direct `store.agents.listByProject` roster consumers filter explicitly: `ask.server.ts`
  (delegation target), `controller.server.ts` (teammate env), `teammate-refresh.server.ts`,
  and `roster.server.ts`/`teammateRoster` (defense in depth).

The name `assistant` is reserved in add-member validation.

## 4. The bundled assistant project (`assistant-template/`)

Eden-owned, fixed layer, bundled into the runtime image (`COPY assistant-template …` in the
Dockerfile, like `catalog/`).

- `package.json` + committed `package-lock.json` (deps `eve`, `zod`,
  `@ai-sdk/openai-compatible`); scripts `dev: eve dev`, `build: eve build`.
- `agent/agent.ts` — `defineAgent` with an OpenAI-compatible OpenRouter provider reading
  `process.env.OPENROUTER_API_KEY`; model from `process.env.EDEN_ASSISTANT_MODEL ??
  "anthropic/claude-sonnet-5"` (env-driven, so a per-project model needs no rebuild of the
  fixed layer — only an env change + restart).
- `agent/instructions.md` — the evolved METHOD (the fixed system layer): file conventions,
  secrets rules, add-dependency discipline, verify loop, summary contract, the project/team
  model, that all writes go through `eden_*` tools and land as drafts for human review, that it
  can scaffold members and edit its own `.eden/assistant/**` config, and a marked slot where
  the user's project instructions are appended at boot.
- `agent/tools/*.ts` — thin `fetch` wrappers over Eden's callback API (pattern:
  `app/team/tool-template.ts`): `eden-list-files`, `eden-read-file`, `eden-write-file`,
  `eden-delete-file`, `eden-add-dependency`, `eden-run-checks`, `eden-project-context`,
  `eden-scaffold-member`, `eden-catalog`. Each reads `EDEN_API_URL` + `EDEN_ASSISTANT_TOKEN`,
  POSTs JSON, returns the body (HTTP 200 even for business errors, per the ask.server.ts
  convention).
- `agent/skills/building-eve-agents.md` — at least one skill so the sandbox template exists.
- `agent/sandbox.ts` — minimal scratch shell; instructions state repo changes NEVER go through
  the sandbox.
- `agent/entrypoint.sh` — baked into the image; see §5.
- `VERSION` / manifest — the template content hash is the release identity.

### User-layer materialization (entrypoint)

At container start `agent/entrypoint.sh`:
1. `GET {EDEN_API_URL}/api/assistant/bundle` (Bearer `EDEN_ASSISTANT_TOKEN`), retried a few
   times. On persistent failure it starts with the fixed layer only.
2. Bundle JSON `{ instructions, files: {path→content}, model }` is assembled server-side from
   the repo's published `.eden/assistant/**` (via `resolveFileView`, so staged-but-unpublished
   config does NOT apply — published only). It writes user skills to `agent/skills/user/…`,
   user schedules to `agent/schedules/user/…`, appends user instructions to
   `agent/instructions.md` under `## Project instructions (user-configured)`, and exports
   `EDEN_ASSISTANT_MODEL` if the bundle carries one.
3. If any user layer was written, `node_modules/.bin/eve build` (recompile), then
   `exec node_modules/.bin/eve start`. If nothing was written, skip the rebuild.

### Image build

`buildAssistantImage()` (`app/deploy/eve-image.server.ts`) is a build-from-local-directory
variant of `buildEveImage`: it copies `assistant-template/` into the build context instead of
fetching a GitHub tarball, and reuses the identical Dockerfile / two-stage build / digest
inspect. One shared image per template content hash, tagged `eden-assistant:<hash>`, built
lazily on first provision after an Eden upgrade.

## 5. Instance lifecycle

`app/assistant/instance.server.ts`:
- `ensureAssistantAgent(projectId)` — upsert the `kind:'assistant'` row + its internal
  environment.
- `ensureAssistantInstance(projectId)` — ensure agent, env, release (current template hash),
  image, and a live deployment; returns `{ url, deploymentId, status }`. Long work
  (build+deploy) runs through the jobs queue: `JobKind` gains `'assistant_deploy'` with a
  worker handler. While provisioning, the UI shows a provisioning state.

Deploy env for the instance (no user secrets ever injected):
- `OPENROUTER_API_KEY` (workspace key; clear error if absent, mirroring `deployRelease`),
- `EDEN_ASSISTANT_MODEL` (workspace `assistantModel` default, or the per-project override),
- `EDEN_API_URL` (same `host.docker.internal:${PORT}` logic as `EDEN_TEAM_URL`, override
  `EDEN_ASSISTANT_API_URL`),
- `EDEN_ASSISTANT_TOKEN` = `mintAssistantToken(deploymentId)` (§6),
- `worldKey` = the internal environment id (sessions survive redeploys).

Anti-shadowing: `EDEN_ASSISTANT_*` and `EDEN_API_URL` are deleted from any resolved env before
being set.

Wake/refresh:
- Before a turn, if the deployment is stopped, `deployTarget.start()`.
- When a merge touches `.eden/assistant/**` (same merge webhook path that runs roster sync +
  teammate refresh), restart the deployment (stop/start — the entrypoint re-fetches the bundle
  and rebuilds; no new image, no env change).
- When the bundled template hash differs from the deployed release's (Eden upgraded), queue an
  `assistant_deploy` redeploy with the new image.

## 6. Callback API (control plane)

Tokens: `app/assistant/token.server.ts`, same HMAC-SHA256-over-deploymentId scheme as team
tokens but a **distinct prefix `edna_`** so assistant and team tokens are not interchangeable.

Routes `app/routes/api.assistant.*.ts` verify Bearer token → deployment → environment → agent
(must be `kind:'assistant'`) → project. 401 only for a bad token; business errors are
`{ ok:false, error }` at HTTP 200 (so the model reads the text). Endpoints: `bundle` (GET),
`list-files`, `read-file`, `write-file`, `delete-file`, `add-dependency`, `run-checks`,
`project-context`, `scaffold-member`, `catalog`.

All business logic lives in `app/assistant/authoring.server.ts` (extracted from the old loop:
`listFiles`, `readRepoFile`, `writeRepoFile`, `addDependency` with the npm
`--package-lock-only` scratch-dir discipline + manifest-prefix handling, `runChecks`) with
injected deps (`AuthoringDeps`), so it unit-tests with zero I/O.

### Path policy (server-enforced)

`normalizeAssistantWritePath` (generalizing `normalizeAgentPath` in guard.server.ts): writable
paths are any member root (`agent/**`, `agents/<m>/agent/**`), member package manifests only via
add-dependency, plus `.eden/assistant/**` restricted to `instructions.md`, `skills/*.md`,
`schedules/*.md` (never `.ts` — the assistant cannot rewrite its own fixed tool/agent code).

### Draft author attribution — decision

Two draft-staging paths, two authors:
- **Assistant model** (via a callback tool): the `EDEN_ASSISTANT_TOKEN` authenticates the
  DEPLOYMENT, not a user — the model calls the tool, and the browser's user isn't threaded
  through eve's stateless call. These drafts store `createdBy: null`. `createdBy` is a nullable
  FK to `users`, so a synthetic id like `assistant:<projectId>` isn't storable and a real-but-
  wrong user id would be a lie; null is the least-lying, FK-safe choice. The Changes UI tolerates
  a null author.
- **Human config edits** (the assistant config page, §8): staged with `createdBy = auth.user.id`,
  the real editor — normal attribution.

### run-checks / publish-gate for assistant-only changesets

`.eden/assistant/**` is markdown config outside any eve build. `run-checks` and `publishDrafts`
skip the build gate when every selected draft is under `.eden/assistant/**` (there is nothing
to compile). Mixed changesets still build the affected member.

## 7. Durable sessions + streaming UI

The playground's detached drain loop was extracted into `app/chat/turn-stream.server.ts`
(`runStreamingTurn`) taking injected `send`, progress/cursor persistence callbacks, and the
record pair — used by BOTH the playground stream route and
`app/routes/api.projects.$projectId.assistant.stream.ts`. Differences for the assistant: target
resolution is `ensureAssistantInstance` (emitting provisioning/starting states) instead of
`liveTargets`; the tenancy guard is project-level; runs are recorded with `channel:"assistant"`.

The Assistant page (`app/routes/projects.$projectId.assistant.tsx`) is modeled on the
playground page: session list + New conversation, streaming transcript with live step/tool
activity, input-request answering, transcript rebuilt from eve's stream on load
(`loadPlaygroundEntriesFromEve`). A mid-run reload shows the turn still running and re-attaches
via `status === "running"` + loader replay (same mechanism as the playground).

## 8. Configuration surfaces

Under the Assistant section:
- Project instructions → editor staging `.eden/assistant/instructions.md`.
- Skills + Schedules lists/editors over `.eden/assistant/skills|schedules` (reusing the
  existing resources/edit/edit-schedule machinery; the assistant agent row's root makes
  `buildAgentConfig` work as-is). Visible categories restricted to skills + schedules (tools
  are fixed).
- The FIXED layer is shown read-only (bundled instructions.md + tool list) so the assistant is
  inspectable.
- Model override stored as `.eden/assistant/assistant.json` `{ "model": "…" }`, included in the
  bundle → exported as `EDEN_ASSISTANT_MODEL`; workspace `assistantModel` is the default.

These publish through the normal Changes flow; the refresh-on-merge hook restarts the instance
so config applies. UI copy states "takes effect after publish + merge".

## 9. Routing

- Repo-level `/repos/:projectId/assistant` is the surface for single-agent AND team repos
  ("Assistant" added to the `single` and `repo` nav tab sets; removed from `member`).
- The member-level `member-assistant` route redirects to the repo-level assistant.

## 10. Operational notes

- **Image lifecycle:** one shared `eden-assistant:<hash>` image per template content hash, built
  lazily. An Eden upgrade that changes `assistant-template/` yields a new hash → new release →
  queued redeploy.
- **Boot cost:** when a user layer is present the entrypoint runs `eve build` at container
  start (seconds for the small fixed+user layer). Health polling uses the same
  `DEPLOY_HEALTH_TIMEOUT_MS`/`WAKE_HEALTH_TIMEOUT_MS` as any instance.
- **Refresh triggers:** only the merge webhook/merge path restarts on `.eden/assistant/**`
  changes; loader self-heal never touches the assistant row or triggers deploys (trigger
  discipline from `teammate-refresh.server.ts`).
- **World DB:** keyed by the internal environment id, so sessions + sandbox filesystems survive
  redeploys — same invariant as user instances (one World DB per running instance).
</content>
</invoke>
