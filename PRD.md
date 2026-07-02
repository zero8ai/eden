# Eden — Product Requirements Document

> **Working name:** Eden (a companion to Vercel's **eve**). Rename TBD.
> **Status:** Draft v0.1 · **Owner:** asiraky@gmail.com · **Last updated:** 2026-07-01

---

## 1. Summary

**Eden is a web application for building, managing, and deploying [eve](https://github.com/vercel/eve) agents without writing code by hand.**

eve is Vercel's open-source, filesystem-first framework for durable AI agents: every agent is a
directory of files (`instructions.md`, `tools/*.ts`, `skills/*`, `subagents/*`, `channels/*`,
`schedules/*`, `connections/*`, `agent.ts`) that eve compiles into a portable Nitro application.
It is powerful, but authoring an agent today means a developer opening a GitHub repo and editing
TypeScript and Markdown by hand. Product managers — the people who actually know what the agent
should *do* — cannot participate directly.

Eden closes that gap. It is a structured, opinionated web interface over an eve repository plus an
embedded coding assistant, so a non-developer can:

1. **Connect or create** the eve project (via a GitHub App) and initialize it.
2. **Author every part of an eve agent** through the UI — including generating the TypeScript for
   tools with the help of an in-app coding agent.
3. **Ship it** through a git-native review flow (branch → pull request → merge) that triggers a
   **deployment** to a running instance — with the option for Eden to fully host and operate that
   instance on the customer's behalf.

Eden ships as an **open-source product anyone can self-host**, and as a **commercial managed
service** where Eden runs the infrastructure, meters usage, and bills the customer. Both are the
same product over the same seam; the managed service is the OSS product plus a managed credential
pool, metering, and billing.

---

## 2. Problem & opportunity

- **eve's authoring surface is developer-only.** Even the "no code" parts (instructions, skills)
  live in a git repo; the genuinely-code parts (tools are TypeScript with Zod schemas, `agent.ts`
  config, connections) are out of reach for PMs. Vercel's own blog notes non-technical teams built
  agents — but only *with* engineering support. Eden removes the engineering dependency.
- **The full capability of eve is never exposed in one place.** There is no visual, guided way to
  see and configure an agent's model, tools, skills, subagents, channels, schedules, approvals,
  connections, secrets, and evals together.
- **Deployment and lifecycle are manual.** Getting an eve app running, wiring its stateful
  dependencies (a Workflow "World" store, a sandbox backend, model keys), and re-deploying on change
  is devops work. PMs want a button.
- **Commercial gap.** eve is free and open. There is room for a managed "we run it for you" offering
  where the customer never touches infrastructure — the classic OSS-core + hosted-service model.

---

## 3. Goals & non-goals

### Goals
- Expose **100% of eve's agent-configuration surface** through a web UI, backed by real files in a
  git repo (eve's source of truth).
- Let a PM **create a working, deployed agent end-to-end** without hand-writing code, including
  AI-assisted authoring of TypeScript tools.
- Make change management **git-native**: every edit is a branch + pull request; merge triggers
  deploy. This gives review, history, rollback, and CI for free.
- Provide **one-click deployment and lifecycle management** for one or many instances of an agent,
  via a pluggable `DeployTarget` adapter. Default target is a **portable container image + Postgres
  Workflow World**.
- Offer a **managed commercial mode** (v1): Eden owns the infra, meters usage, and bills the customer.
- Keep the whole thing **self-hostable and open source**.

### Non-goals (for v1)
- Being an eve *replacement* or a general low-code app builder. Eden authors eve projects; it does
  not invent a new agent runtime.
- A visual node-graph / flowchart builder for agent logic. eve's model is files + an LLM loop, not a
  DAG; Eden mirrors that.
- Supporting non-eve agent frameworks.
- Building our own model-hosting/inference. We use provider keys / AI Gateway.

---

## 4. Users & personas

| Persona | Needs from Eden |
|---|---|
| **Product Manager (primary)** | Create and iterate on agents: instructions, tools, skills, schedules, channels. Uses the assistant to generate tool code. Ships via a review flow. Cannot write TypeScript. |
| **Engineer / Platform owner** | Reviews the PRs Eden opens, owns secrets and connections, approves risky tools, self-hosts Eden or manages the managed-service account. Wants git to stay the source of truth. |
| **Ops / Admin** | Manages members, deployment targets, billing (managed mode), environment/secret governance, and approval policies. |

---

## 5. Background: the eve substrate Eden must fully expose

Eden's UI is a faithful, guided editor over these eve concepts. This inventory *is* the config
surface Eden must cover.

| eve concept | File / API | What Eden must let a PM do |
|---|---|---|
| **Runtime config** | `agent/agent.ts` → `defineAgent({ model, ... })` | Pick model (provider-prefixed string, e.g. `anthropic/claude-sonnet-5`), set runtime options, thinking level, etc. via forms. |
| **Instructions** | `agent/instructions.md` | Rich Markdown editor for the always-on system prompt, with assistant help and templates. |
| **Tools** | `agent/tools/*.ts` → `defineTool({ description, inputSchema (Zod), execute, needsApproval, outputSchema, toModelOutput })` | Create/edit tools. The **assistant generates the TypeScript**; PM edits description, inputs, approval policy in a form; test-run in a sandbox. |
| **Skills** | `agent/skills/*` (Markdown playbooks; installable via skills CLI) | Author/import on-demand skill docs. |
| **Subagents** | `agent/subagents/*` (own config) + built-in `agent` tool | Define specialist child agents with their own model/instructions/tools. |
| **Channels** | `agent/channels/*` (HTTP, Slack, Discord, Teams, web, CLI) | Enable/configure entry points; manage route-auth secrets; preview web chat. |
| **Connections** | `agent/connections/*` (typed external integrations) | Configure typed integrations + credentials (paired with Vercel Connect on Vercel, or generic creds off-Vercel). |
| **Schedules** | `agent/schedules/*` (crons) | Create recurring jobs (daily report, weekly digest) with a cron UI. |
| **Sandbox** | `agent/sandbox/*` / `defineSandbox()`; `defaultBackend()` local vs Vercel Sandbox | Choose/configure the sandbox backend (needed both for authored tools and for our own tool test-runs). |
| **Approvals / HITL** | `needsApproval` on tools (`always()`, `once()`, predicates) | Toggle and configure human-approval gating per tool. |
| **Evals** | TypeScript eval suites, run locally or vs deployed | Author scored checks; run as a deploy gate (later phase for full UI). |
| **Env vars / secrets** | project environment variables | Manage secrets per environment (dev/preview/prod) with encryption and scoping. |
| **Observability** | Agent Runs (Vercel) / OpenTelemetry via `instrumentation.ts` + the Workflow event log | **First-class pillar (§7.6):** per-agent, per-run transcript + metrics dashboard (inputs, model/tool calls, outputs, errors, tokens, wall-clock). Eden supplies its own runs store/UI on every host, not just Vercel. |
| **Build/runtime** | `eve build` → `.eve/` (compiled artifacts) + `.output/` (Nitro host); runtime = **Nitro + Workflow SDK**; durability via **Workflow "Worlds"** (Local dev, **Postgres** reference, community Redis/Mongo/Turso/Cloudflare) | Eden drives build + deploy and wires the Workflow World, sandbox backend, and model keys. |

**Key portability fact (validated against source):** `eve build` emits a standard **Nitro
`.output/`** deployable via Nitro presets to *any* supported host. Durability is the open-source
**Workflow SDK**, whose **Worlds** adapter system (event log + compute + queue) has a **Postgres**
reference implementation for self-hosting and a **Local World** for dev. The sandbox and model layer
are likewise adapters (local bash/Docker sandbox; direct provider keys off-Vercel). **eve is not
Vercel-locked** — off-Vercel you supply three things: a Workflow World store, a sandbox backend, and
model keys. This is the foundation of Eden's deployment design.

---

## 6. Product pillars

Eden has five pillars. v1 delivers all five; depth is phased (§11).

1. **Connect** — GitHub App integration: create a new eve repo or connect an existing one; run
   `eve init`; detect and parse the agent structure.
2. **Author** — the full visual config surface of §5, backed by files, with an embedded **Pi-based
   coding assistant** that writes/edits the code parts (tools, connections, `agent.ts`) for PMs.
3. **Review & version** — git-native change flow: edits accumulate on a branch and open a **pull
   request**; merge is the ship signal.
4. **Deploy & operate** — one-click deploy through a `DeployTarget` adapter (default: container +
   Postgres World); manage multiple instances/environments; **managed mode** where Eden runs it and
   bills usage.
5. **Observe** — first-class run observability: for every agent, browse every execution and open the
   **full transcript** — the triggering input, each model call and tool call (with inputs, outputs,
   and errors), the final answer, plus tokens, wall-clock time, and execution context.

---

## 7. Pillar detail

### 7.1 Connect — GitHub App & repo lifecycle

- **GitHub App** (not just OAuth) so Eden can create repos, read/write files, open PRs, manage
  branches, and receive webhooks on the user's behalf, scoped to selected repos.
- **Two entry paths:**
  - *Create new:* Eden creates a repo and scaffolds it by running the equivalent of
    `npx eve@latest init` (an eve project skeleton), commits the initial structure.
  - *Connect existing:* point Eden at an existing eve repo; Eden validates it is an eve project
    (`agent/` present), parses the manifest, and hydrates the UI from the files.
- **Repo model = source of truth.** Eden never keeps a divergent copy of agent config; it reads and
  writes the files. UI state is a projection of the repo (plus in-flight, uncommitted edits on a
  working branch).
- **Detection & sync:** webhooks keep Eden in sync when the repo changes outside Eden (an engineer
  edits a tool directly). Conflicts surface in the UI.

### 7.2 Author — visual config + embedded coding assistant

**Structured editors** for each eve concept in §5 (forms for `agent.ts`/approvals/schedules/channels;
Markdown editors for instructions/skills; a code view for tools/connections).

**Embedded authoring assistant (Pi SDK).** Built by embedding
[`@earendil-works/pi-coding-agent`](https://github.com/earendil-works/pi/tree/main/packages/coding-agent)
as a library — *not* eve. Rationale: Eden itself is a normal web app, not an eve runtime; Pi's SDK
(`createAgentSession`, custom `defineTool` tools, streaming events, model registry, in-memory or
persisted sessions) is designed exactly for embedding an agent inside your own app.

The assistant:
- **Writes and edits tool TypeScript** from a PM's natural-language description ("a tool that looks up
  an order by ID in our Postgres and returns status"), producing a valid `defineTool(...)` file with a
  Zod `inputSchema`, description, and `execute` body — then explains it in plain language.
- **Operates on a workspace bound to the working branch** (Pi's built-in `read`/`write`/`edit`/`bash`
  tools scoped to a checkout/sandbox of the repo), so its edits become part of the same PR.
- **Helps configure everything else**: drafts instructions, proposes skills, wires connections and
  the env vars/secrets a tool needs, and can run the tool in a sandbox to validate.
- **Is scoped and safe**: custom Eden tools (via Pi's `customTools`) expose only repo-authoring and
  sandbox-test actions; destructive/host actions are excluded. Model + keys come from Eden config.

> **Decision (revised 2026-07-02):** v1 ships a **Claude-API generator** (stateless: describe →
> generated `defineTool` file → lands on the working branch via the normal PR flow) behind an
> `AuthoringAssistant` seam, with a Pi adapter stubbed next to it. The full **Pi SDK live session**
> (persistent workspace bound to a working-branch checkout, streaming read/write/edit/bash) remains
> the target for the richer experience but depends on the workspace-checkout spike (§12) — it slots
> in behind the same seam without touching the editors.

**Secrets & env vars UI:** when a tool or connection needs a secret, the assistant references it by
name; the PM sets the value in Eden's secrets manager (per environment), never in code. Values are
encrypted at rest and injected at deploy time.

### 7.3 Review & version — git-native flow

- All Eden edits (form changes and assistant code changes) land as commits on a **working branch**
  per change-set ("Add order-lookup tool").
- Publishing a change-set opens a **pull request** with a human-readable summary of what changed
  (diff of files + a plain-language changelog Eden generates).
- **Merge = ship.** Merging the PR (in Eden or on GitHub) triggers the deploy pipeline (§7.4).
- Benefits inherited for free: review, approvals, history, blame, rollback (revert PR),
  branch previews, and CI hooks (evals as a gate — later phase).
- **Preview environments:** a PR can optionally deploy a preview instance so a PM can try the change
  before merge (maps to eve preview deployments / a Postgres-World preview instance).

### 7.4 Deploy & operate — `DeployTarget` adapter

**Build:** on merge, Eden runs `eve build` to produce `.eve/` + the Nitro `.output/`, then packages a
**container image** of the host.

**`DeployTarget` adapter interface** — one seam, multiple providers. Each adapter knows how to:
1. take the built image/output,
2. ensure the three stateful dependencies exist — a **Workflow World** (default **Postgres**), a
   **sandbox backend**, and **model API keys / gateway** —
3. deploy/replace the running instance, and
4. report health, logs, and runs.

**Default target (v1): Container + Postgres World.** Build a Docker image of `.output/`, run it on a
generic container host (Fly/Railway/Cloudflare/VPS/our cloud) with a Postgres Workflow World and a
sandbox backend. This is the portable path and underpins both OSS-BYO and managed modes.

**Credential-ownership models over the same adapter:**
- **BYO (OSS / self-host):** customer connects their host + their Postgres + their model keys. The
  instance runs in *their* account; they pay their providers. Eden orchestrates.
- **Managed (commercial, v1):** *Eden* owns the host, the Postgres World, the sandbox, and pays the
  bills; the customer never picks a provider. Eden meters usage and bills the customer (§8).

**Other targets behind the seam (later):** a **Vercel** adapter (zero-config: Workflows store,
Vercel Sandbox, AI Gateway auto-wire) and additional Worlds (Redis/Turso/Cloudflare).

**Instance & environment management:**
- Multiple **environments** per agent (dev / preview / prod) and multiple **instances/deployments**
  (e.g. per customer, per region) from one agent codebase.
- Per-instance: status, logs, runs/observability, secrets, scaling knobs, start/stop, rollback,
  and the channel endpoints (HTTP URL, Slack install, cron status).

### 7.5 Managed commercial offering (v1)

The managed mode turns Eden into a hosted service:
- **Managed credential pool:** Eden-owned provider accounts/infra; customers deploy without bringing
  cloud accounts.
- **Multi-tenancy & isolation:** each customer's instances run isolated (separate namespaces/DBs;
  sandbox isolation per eve's model).
- **Metering:** capture requests, compute-seconds, sandbox usage, and model tokens per instance.
- **Billing:** plans + usage-based billing (Stripe or similar); Eden pays providers, marks up.
- **Governance:** org/team/roles, SSO (later), audit log, approval policies, spend limits.

### 7.6 Observe — run observability

Observability is a primary reason teams can trust an agent in production. Eden must let anyone open
**any agent** and inspect **any execution** of it in full. This works on **every deploy target**
(managed and BYO/self-host), not just Vercel's Agent Runs.

**The unit of observation.** A **Session** is a durable conversation/task; each triggering input
(user message, HTTP request, channel event, or a scheduled cron) creates a **Run** (one turn:
input → agent loop → final output). A Run contains an ordered list of **steps**: model calls, tool
calls, reasoning, and messages. The dashboard is: *Agent → its Runs → drill into one Run's transcript.*

**Per-Run summary (the list/overview view)** — scannable without opening the transcript:
- trigger/source (channel, cron, HTTP), start time, **wall-clock duration**,
- **status** (success / error) and error surface,
- **tokens** (input / output / total) and estimated cost,
- model(s) used, **# tool calls**, **# tool errors**,
- the **agent version** it ran against (git commit / build id — see below).

**Per-Run transcript (the detail view)** — progressive disclosure so it isn't overwhelming:
- the **user/input prompt** for that run (runtime data — always recorded),
- an ordered timeline of steps, each collapsible:
  - **model calls:** the messages sent, the assistant output/reasoning, tokens, latency, model,
  - **tool calls:** tool name, **input arguments**, **output/result**, **error** (if any),
    duration, and whether it hit an approval gate,
- final answer, and links to any **subagent** runs spawned during the turn.

**System prompt — link, don't (only) snapshot.** Each Run records the **deployed agent version**
(git commit SHA / build id) it executed under. Because `instructions.md`, tools, and skills all live
in the repo, Eden reconstructs the exact **system prompt at run time by linking to that commit** —
no need to duplicate it in the telemetry store (resolving the user's open question). Eden *may* also
snapshot the resolved system prompt for convenience/immutability, but the versioned source is the
source of truth. The **user input**, tool I/O, tokens, and timing are runtime data and *are* recorded.

**Where the data comes from.** Two complementary sources (see ARCHITECTURE §3.7): eve's
**OpenTelemetry** AI-SDK spans (via `agent/instrumentation.ts`) give tokens, model, latency, and
model/tool I/O; the **Workflow event log** (in Postgres) is the durable, replayable record of every
turn and step. Eden ingests both into its own runs store and renders the UI.

**Cross-cutting requirements:** works for **BYO** deploys by shipping telemetry from the customer's
instance to Eden's collector over an authenticated OTLP endpoint; **tenant-isolated** in managed
mode; **access-controlled** via WorkOS roles (transcripts contain sensitive prompt/response data);
**retention + redaction** controls; and the deployer-disclosure note eve already flags. Token counts
here relate to but are distinct from **billing metering** (§7.5): the model gateway is the billing
source of truth; observability is the per-run detail view.

### 7.7 Version & release

eve has **no built-in agent-versioning primitive** (validated against source): it is git-native
(`init` initializes git) and relies on **immutable deployments**. Eden builds a thin product layer
over that — it does *not* invent a parallel versioning system.

**A Release = an immutable build of an agent at a git commit.** Because we are already
branch → PR → merge → deploy, the **merge commit SHA is the canonical, immutable version identity**,
and the container image built from it is content-addressed. Immutability is therefore inherited from
git + image digests, not engineered. A Release carries: a friendly label (auto-incremented
`v1, v2, …` / release #N), the commit SHA, the image digest, the plain-language changelog Eden
already generates for the PR, author, and timestamp. Environments/deployments point at a Release.

**Why it matters (three payoffs):**
1. **Observability linkage.** Every Run is tagged with its Release/commit (§7.6). A run from two weeks
   ago reconstructs its *exact* system prompt, tools, and skills from the repo at that commit —
   immutable versioning is what makes the observability system-prompt link truthful.
2. **Safe iteration / revert.** *Fast rollback* re-points an environment at a previous Release (its
   image is retained) — near-instant, no rebuild. *Git revert* opens an undo PR so the repo stays
   honest. PMs can be cavalier because undo is one click.
3. **Run multiple versions at once (the core primitive).** Eden can deploy **more than one Release of
   the same agent concurrently** behind a **weighted, session-sticky traffic splitter** at ingress
   (a conversation stays pinned to one version for its lifetime). This is a generalization of "one
   deployment per environment" to "N deployments behind a splitter."

**"A/B" is emergent, not a first-class feature.** Eden deliberately does **not** build an automated
experimentation framework — no thumbs UI, no eval-gated winner selection, no auto-rollout engine in
v1. The product gives PMs (a) the ability to run multiple versions live and (b) **per-version
telemetry** (Runs are already version-tagged, so observability groups/filters/compares by Release).
The human looks at each version's telemetry and decides. Progressive/auto rollout can come later as a
policy on top of the splitter + per-version metrics, but it is not required for the value.

**Immutability caveat:** a Release pins everything *in the repo* (config, tools, skills, instructions)
but **not secrets/env vars**, which live outside git and change independently. For faithful
"what ran then" we version secret *metadata/generation* (never values), and note that a Release is
code+config, not full runtime state.

---

## 8. System architecture (high level)

```
                    ┌────────────────────────────────────────────┐
                    │                 Eden Web App                │
                    │  (Next.js UI + API; OSS + managed control)  │
                    └───────┬───────────────┬───────────────┬─────┘
                            │               │               │
              GitHub App ◄──┤               │               ├──► Pi authoring assistant
              (repos, PRs,  │               │               │    (@earendil-works/
               webhooks)    │               │               │     pi-coding-agent, sandboxed
                            │               │               │     checkout of working branch)
                            │               │               │
                     Secrets/Env store      │        DeployTarget adapters
                     (encrypted, per-env)    │        ├─ Container + Postgres World (default)
                            │                │        ├─ Vercel (later)
                            │          Metering/Billing│        └─ others (Redis/Turso/CF Worlds)
                            │          (managed mode)  │
                            ▼                          ▼
                    ┌───────────────┐        ┌──────────────────────────┐
                    │  eve repo(s)  │  build │  Running eve instance(s)  │
                    │  = source of  │───────►│  Nitro .output/ +         │
                    │  truth        │ eve    │  Workflow World (Postgres)│
                    └───────────────┘ build  │  + sandbox + model keys   │
                                             │  channels: HTTP/Slack/... │
                                             └──────────────────────────┘
```

**Core components**
- **Web app (React Router 7 / Vite):** UI + control-plane API, built on **React Router 7 framework
  mode** (the `@react-router/dev` Vite plugin — SSR, loaders/actions, nested routing). OSS-deployable;
  managed adds tenancy/billing.
- **Identity & auth (WorkOS AuthKit):** authentication, **Organizations**, roles, permissions, SSO,
  and directory sync. Scaffolded via the AuthKit CLI installer (`npx workos@latest install`, which
  supports React Router) once the app skeleton exists. WorkOS Organizations map directly to Eden tenants, so most managed-mode
  governance is delegated rather than hand-rolled (see §9).
- **GitHub integration service:** app auth, file R/W, PR/branch management, webhook ingestion.
- **Authoring assistant service:** hosts Pi sessions against a sandboxed working-branch checkout;
  streams tokens/tool events to the UI.
- **Secrets service:** encrypted per-environment secret storage + deploy-time injection.
- **Deploy controller:** runs `eve build`, packages the image, invokes the `DeployTarget` adapter,
  tracks instance state.
- **Metering & billing (managed):** usage capture + plan/invoice management.
- **Release registry:** immutable Releases (label, commit SHA, image digest, changelog) and the
  Release each environment/deployment points at — the version layer over git (§7.7).
- **Traffic splitter (ingress):** weighted, session-sticky routing across concurrent Releases of one
  agent, so multiple versions can run live at once (§7.7).
- **Eden datastore:** projects, repos, environments, instances, releases, members, secrets metadata,
  runs index, billing — *not* agent config (that lives in the repo).

**Data-model note:** agent configuration is **not** duplicated in Eden's DB. The repo is
authoritative; Eden stores pointers, projections/cache, and operational metadata only. This avoids a
two-source-of-truth reconciliation problem.

---

## 9. Cross-cutting concerns

- **Identity, auth & tenancy (WorkOS AuthKit):** all authentication runs through **WorkOS AuthKit**,
  installed with `npx workos@latest install` (AI-powered installer: detects the framework, adds the
  SDK, generates OAuth callback routes + auth middleware, configures redirect URIs/CORS in the WorkOS
  dashboard, writes `.env.local`, validates the build). A **WorkOS Organization = an Eden tenant**;
  AuthKit's orgs / roles / permissions / SSO / directory-sync / webhooks provide the managed-mode
  governance layer, so Eden does not hand-roll org/role/SSO. Requires Node 20+ and a WorkOS account.
  The same auth is used by the OSS install (single org) and managed (many orgs).
- **Security & secrets:** encrypted at rest, scoped per environment/instance, never written to repo
  files; least-privilege GitHub App scopes; the assistant runs in an isolated sandbox and cannot
  reach production secrets or hosts.
- **Observability (pillar §7.6):** Eden ships its own run-observability subsystem on every host (not
  just Vercel's Agent Runs) — per-agent, per-run transcripts + metrics, fed by eve's OpenTelemetry
  (`instrumentation.ts`) and the Workflow event log. See ARCHITECTURE §3.7 for the pipeline.
- **Approvals surfaced in UI:** tool `needsApproval` events must render as actionable items in Eden
  (and in Slack where used), pausing the durable session with no compute cost until resolved.
- **Multi-repo / multi-agent:** an org may manage many eve projects; Eden lists and switches between
  them.

---

## 10. Success metrics

- **Activation:** % of connected repos that reach a first successful deploy.
- **PM autonomy:** % of tools created via the assistant with no manual code edit before merge.
- **Time-to-first-agent:** median time from connect → deployed working agent.
- **Iteration velocity:** PRs merged per agent per week.
- **Managed conversion (commercial):** OSS → managed upgrade rate; usage-based revenue per account.

---

## 11. Phasing

**Milestone 0 — Foundations**
- React Router 7 (Vite) app skeleton; **auth via WorkOS AuthKit** (`npx workos@latest install`);
  org/project model built on WorkOS Organizations.
- GitHub App: connect existing repo, parse eve project, read files.
- Read-only visualization of an eve agent's full config surface.

**Milestone 1 — Author (no deploy yet)**
- Structured editors for all §5 concepts (write path).
- Working-branch + PR flow (branch → commit edits → open PR → merge).
- Embedded Pi assistant: generate/edit tool TypeScript; sandbox test-run; secrets UI.
- `eve init` for new-repo creation.

**Milestone 2 — Deploy + versioning (default target)**
- Deploy controller + `DeployTarget` adapter interface.
- **Container + Postgres World** adapter; BYO-credential deploys.
- **Releases** (immutable = commit SHA + image digest, labels, changelog); version history;
  **fast rollback** (re-point to prior Release) + git-revert.
- **Multiple Releases live at once** behind a **weighted, session-sticky traffic splitter** at ingress
  (the core "run two versions" primitive — §7.7).
- Environments (dev/preview/prod), instance status/logs.
- Merge-triggers-deploy pipeline; optional PR preview instances.

**Milestone 3 — Observe (run observability, §7.6)**
- Telemetry ingestion: OTel collector (`instrumentation.ts`) + Workflow-event-log reader; authenticated
  OTLP endpoint so **BYO** instances ship runs back to Eden.
- Runs store + per-agent **Run list** (tokens, wall-clock, status, tool-call/error counts).
- Per-Run **transcript** view (input, model/tool calls with I/O + errors, final answer); link each Run
  to its deployed git commit/Release to resolve the system prompt.
- **Compare by version:** group/filter Runs by Release so PMs judge concurrent versions from telemetry
  (emergent "A/B" — no formal experimentation framework; §7.7).
- Access control (WorkOS roles), retention + redaction controls.

**Milestone 4 — Managed commercial mode**
- Managed credential pool + multi-tenant isolation (incl. tenant-isolated telemetry).
- Metering + plans + usage billing (reconciled with observability token counts).
- Governance: roles, audit log, spend limits (roles/SSO/directory via WorkOS AuthKit).

**Milestone 5 — Breadth**
- Additional `DeployTarget` adapters (Vercel zero-config; Redis/Turso/Cloudflare Worlds).
- Evals-as-deploy-gate UI; richer observability (traces across subagents, alerting); SSO.
- Optional **progressive rollout** policy (auto-ramp/auto-rollback on thresholds) over the §7.7
  splitter — only if demand appears; not required for the multi-version value.

---

## 12. Open questions & risks

- **eve beta churn.** eve is in public beta; APIs (`defineAgent`, `defineTool`, build output, Worlds)
  may change. Eden must isolate an "eve-version adapter" layer and pin/track eve versions per repo.
  **Sharpened by the spike (docs/SPIKE-EVE.md):** the eve ↔ `@workflow/world-postgres` version pair
  is strict and runtime-enforced (world spec versions) — Eden must treat it as pinned per repo.
- ~~**`eve init` in a server context.**~~ **Resolved (2026-07-02, docs/SPIKE-EVE.md):** `eve init`
  and `eve build` run fully headless (Node ≥ 24; Eden runs them inside build containers). A repo is
  deployable off-Vercel only if it declares the Postgres world in `agent.ts` — Connect should
  validate and offer a "make deployable" PR.
- **Assistant workspace model.** Exactly how the Pi session mounts the working branch (ephemeral
  container checkout vs. persistent) and how its edits map cleanly to PR commits.
- **Sandbox backend for the default target.** Which sandbox implementation Eden ships for authored-
  tool execution off-Vercel (local Docker/bash vs. a hosted microVM equivalent).
- **Observability parity.** How much of Agent Runs' fidelity Eden can reproduce off-Vercel from the
  Workflow event log + OTel.
- **Two-source-of-truth avoidance.** Keep repo authoritative; validate the projection/cache stays
  correct under external repo edits (webhook races, conflicts).
- **Managed multi-tenant security.** Isolation guarantees for customer agents (which run
  model-generated code in sandboxes) in shared Eden infra.
- **Naming/branding & licensing** of the OSS core vs. managed service (open-core boundaries).

---

## 13. Appendix — reference facts validated during research

- eve is filesystem-first; agents are files under `agent/`; directories auto-discovered by name.
- Runtime is **Nitro + Workflow SDK**; `eve build` → `.eve/` (artifacts) + `.output/` (Nitro host).
- Durability via **Workflow "Worlds"** (event log + compute + queue): Local (dev), **Postgres**
  (reference/self-host), community Redis/Mongo/Turso/Cloudflare. State locally under `.workflow-data`.
- **Sandbox** is adapter-based: `defaultBackend()` local bash/Docker; Vercel Sandbox on Vercel.
- **Models** via provider-prefixed strings; AI Gateway (keyless) on Vercel, direct keys elsewhere.
- **Tools:** `defineTool({ description, inputSchema: z.object(...), execute(input, ctx), needsApproval,
  outputSchema?, toModelOutput? })`; `ctx.session`, `ctx.getSandbox()`, `ctx.getSkill(id)`.
- **HTTP contract:** `POST /eve/v1/session` returns `x-eve-session-id`; stream at
  `/eve/v1/session/<id>/stream`.
- **Pi coding-agent SDK:** `createAgentSession`, `SessionManager` (in-memory/persist), `ModelRegistry`,
  `AuthStorage`, `customTools` via `defineTool`, streaming `session.subscribe(...)`,
  `session.prompt/steer/followUp` — designed for embedding an agent in your own app.

*Sources: github.com/vercel/eve, vercel.com/docs/eve/concepts, vercel.com/blog/introducing-eve,
vercel.com/blog/a-new-programming-model-for-durable-execution,
github.com/earendil-works/pi (packages/coding-agent).*
