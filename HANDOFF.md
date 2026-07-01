# Eden — Hand-off & Execution Plan

> **Purpose:** get a new contributor (or a fresh session) productive fast. Where we are, what's
> decided, and the concrete next steps to start executing.
> **Last updated:** 2026-07-01 · **Owner:** asiraky@gmail.com

---

## 1. What Eden is (one paragraph)

Eden is a **web app for building, managing, and deploying [eve](https://github.com/vercel/eve)
agents without hand-writing code**. eve is Vercel's filesystem-first agent framework (an agent =
files under `agent/`: `instructions.md`, `tools/*.ts`, `skills/`, `subagents/`, `channels/`,
`schedules/`, `connections/`, `agent.ts`). Today authoring an eve agent means a developer editing a
git repo. Eden puts a guided web UI + an embedded coding assistant over that repo so **product
managers** can do it, then ships and operates the result. It's **open source + self-hostable**, and
also a **commercial managed service** (Eden runs the infra, meters, bills).

Read next, in order: `PRD.md` (product), `ARCHITECTURE.md` (managed-service infra). This file is the
map between them and the plan.

---

## 2. Locked decisions (don't re-litigate without reason)

| # | Decision | Where |
|---|---|---|
| D1 | **Web stack: React Router 7 framework mode** (`@react-router/dev` Vite plugin — SSR, loaders/actions). **Not Next.js.** | scaffolded |
| D2 | **Auth & tenancy: WorkOS AuthKit** via `npx workos@latest install`. A WorkOS **Organization = an Eden tenant**; orgs/roles/permissions/SSO/directory-sync delegated to WorkOS (no hand-rolled org/role/SSO). | PRD §9 |
| D3 | **Edit model: git-native.** Every change = branch → PR → merge → deploy. The eve **repo is the single source of truth**; Eden stores no divergent copy of agent config. | PRD §7.3 |
| D4 | **Authoring assistant: Pi SDK** (`@earendil-works/pi-coding-agent`) embedded as a library (NOT eve — Eden itself is not an eve app). Generates/edits tool TypeScript for PMs. | PRD §7.2 |
| D5 | **Managed offering is in scope for v1.** Same codebase as OSS + provider implementations + metering/billing + tenancy. No fork. | PRD §7.5 |
| D6 | **Default deploy target: portable Container image + Postgres Workflow World.** Vercel/Redis/Turso/Cloudflare adapters sit behind the `DeployTarget` seam for later. | PRD §7.4 |
| D7 | **Managed substrate: a single bare-metal box + many Docker containers** (budget-driven, NOT Fly/cloud-VM). Isolation via **gVisor** per instance (Kata/Firecracker via bare-metal KVM as the hardening path); scale-to-zero by stopping idle containers + wake-on-request (Sablier); **self-run Postgres, DB-per-instance**; **Nomad** (or Docker API) orchestration; our own **model gateway** for keys/metering/spend caps. | ARCH §2–3 |
| D8 | **Observability is a first-class pillar** — per-agent, per-run transcript + metrics (input, model/tool calls w/ I/O + errors, final answer, tokens, wall-clock). Own runs store fed by eve OTel + Workflow event log; BYO ships telemetry to an authenticated OTLP endpoint. | PRD §7.6, ARCH §3.7 |
| D9 | **Versioning: a Release = an immutable git merge-commit + content-addressed image** (label v1/v2, changelog). Enables observability system-prompt linkage, fast rollback + git-revert, and **running multiple versions live at once** behind a weighted, session-sticky ingress splitter. | PRD §7.7, ARCH §3.9 |
| D10 | **"A/B" is emergent, NOT a first-class feature.** No thumbs/eval-winner/auto-rollout in v1. Give PMs multi-version deploy + per-version telemetry; the human decides. | PRD §7.7 |

**Key validated fact:** eve is **portable, not Vercel-locked**. `eve build` emits a standard Nitro
`.output/`; durability is the open-source Workflow SDK's "Worlds" adapters (Postgres reference for
self-host); sandbox + model layers are adapters. Off-Vercel you supply: a Workflow World store, a
sandbox backend, and model keys. eve also has **no native versioning** (git + immutable deploys only)
— D9 is entirely our layer.

---

## 3. The five product pillars (PRD §6)

1. **Connect** — GitHub App: create/connect an eve repo, run `eve init`, parse the agent.
2. **Author** — visual editors for every eve concept + the Pi assistant that writes tool code.
3. **Review & version** — branch → PR → merge is the ship signal.
4. **Deploy & operate** — one-click deploy via `DeployTarget` (container + Postgres World); managed
   hosting/metering/billing.
5. **Observe** — per-agent, per-run transcript + metrics dashboard.

---

## 4. Where we are right now (state)

**Design:** PRD.md and ARCHITECTURE.md are complete drafts (v0.1) covering all five pillars, the
managed bare-metal architecture, versioning, and observability. Decisions D1–D10 are made.

**Code — M0 skeleton scaffolded and green:**
- React Router 7 (v8) + Vite app at repo root, SSR, Tailwind 4, TypeScript, Dockerfile.
- `app/routes/home.tsx` = an Eden dashboard placeholder (hero + the 5 pillar cards).
- Package renamed to `eden`; generic welcome template removed.
- **Verified:** `npm install` (0 vuln), `npm run typecheck`, `npm run build`, `npm run dev` all pass;
  dev server renders `200` with `<title>Eden</title>`.

**Repo layout:**
```
eden/
├── PRD.md              # product requirements (five pillars, milestones §11)
├── ARCHITECTURE.md     # managed-service infra (control/data plane, bare metal)
├── HANDOFF.md          # this file
├── app/                # React Router 7 app (root.tsx, routes/, app.css)
├── Dockerfile          # container build (fits the deploy story)
├── react-router.config.ts, vite.config.ts, tsconfig.json, package.json
└── public/
```

**Code — M0 step 2 done (control-plane data model):**
- Drizzle + `postgres` installed. `app/db/schema.ts` = 9 tenant-scoped tables keyed by WorkOS
  org/user IDs (D2), no agent config stored (D3): `orgs`, `users`, `memberships`, `projects`,
  `environments`, `releases`, `deployments`, `secrets_metadata`, `runs`.
- `app/db/client.server.ts` (HMR-safe pooled client), `app/db/queries.server.ts` (org-scoped
  access — tenant-isolation invariant in one place), `drizzle.config.ts`, generated
  `drizzle/0000_*.sql`, `db:generate|migrate|push|studio` scripts, `.env.example`.
- **Verified:** `drizzle-kit generate` emits all 9 tables; `npm run typecheck` green.
- Not yet run against a live DB — needs `DATABASE_URL` in `.env.local` then `npm run db:migrate`.

**NOT done yet:**
- **AuthKit not installed** — requires an interactive WorkOS login (see §6, Step 1). Blocks
  wiring org/user rows to real sessions and gating routes.
- No GitHub App, no editors, no deploy, no observability code — all ahead.

---

## 5. Milestones (PRD §11)

- **M0 — Foundations:** RR7 skeleton ✅ · control-plane data model ✅ · WorkOS AuthKit ⏳ · GitHub App
  (connect, parse, read) ⏳ · read-only visualization of an agent's config surface ⏳
- **M1 — Author:** structured editors for all config concepts · working-branch + PR flow · Pi
  assistant (generate/edit tool TS, sandbox test-run) · secrets UI · `eve init` for new repos
- **M2 — Deploy + versioning:** deploy controller + `DeployTarget` · Container+Postgres adapter ·
  **Releases + rollback** · **multi-version live + traffic splitter** · environments · merge→deploy
- **M3 — Observe:** OTel + event-log ingestion · authenticated OTLP for BYO · runs store · Run list +
  transcript · compare-by-version · access control + retention
- **M4 — Managed:** managed credential pool + multi-tenant isolation · metering + billing · governance
- **M5 — Breadth:** more `DeployTarget` adapters · evals-as-gate · richer observability · optional
  progressive rollout · SSO

---

## 6. Immediate next steps (start executing here)

Ordered. First three unblock everything else.

### Step 0 — Initialize git (5 min, needs user OK)
Not a repo yet; Eden is git-native so this should exist. Then push to a GitHub remote when ready.
```bash
cd /Users/aaron/code/eden
git init && git add -A && git commit -m "M0: Eden skeleton + design docs (PRD, ARCHITECTURE, HANDOFF)"
```
Add a `.gitignore` audit first (scaffold shipped one; confirm it ignores `node_modules`, `build`,
`.react-router`, `.env*`).

### Step 1 — Install WorkOS AuthKit (needs the user; interactive)
The installer opens a browser to log into WorkOS and auto-configures the dashboard (redirect URIs,
CORS, keys → `.env.local`). **Cannot be run headlessly.** In-session, the user runs:
```
! npx workos@latest install
```
Prereqs: Node 20+ (have v22), a WorkOS account. It supports React Router. After it lands, wire the
authenticated-session helpers into RR7 loaders and gate routes.

### Step 2 — Data model + org/project foundation (M0)
Pick and stand up the control-plane DB (Postgres — we already run Postgres for the Workflow World, so
standardize on it). Define initial tables keyed by **WorkOS org/user IDs**:
`orgs` (↔ WorkOS org), `users`/`memberships`, `projects` (an eve repo), `environments`,
`releases`, `deployments`, `secrets_metadata`, `runs` (index). Recommend **Drizzle** (TS-first, plays
well with RR7). *Do not* store agent config here — repo is source of truth (D3).

### Step 3 — GitHub App (Connect pillar, M0)
Register a GitHub App (repo contents R/W, PRs, webhooks). Implement: OAuth/install flow, connect an
existing repo, **validate it's an eve project** (`agent/` present), read + parse the file structure
into the read-only config visualization. Create-new-repo (`eve init`) can follow in M1.

### Step 4 — Read-only agent visualization (M0)
Render the parsed agent surface (model, instructions, tools, skills, subagents, channels, schedules,
connections) as read-only views. This proves the parse layer before we build editors in M1.

---

## 7. Open questions / spikes to resolve before the milestone they block

From PRD §12 and ARCH §11:
- **`eve build`/`eve init` headless** — confirm they run non-interactively in a server context (not
  just the interactive TUI). *Blocks M1 (init) and M2 (build).*
- **Pi session ↔ working branch** — how the assistant mounts a checkout so its edits become clean PR
  commits. *Blocks M1.*
- **eve OTel span fidelity** — do AI-SDK spans include full tool input/output, or must we supplement
  from the Workflow event log? Decide the normalized runs schema. *Blocks M3.*
- **Authenticated OTLP ingest for BYO** — public receiver + per-instance tokens + rate limiting,
  no cross-tenant leakage. *Blocks M3 (BYO observability).*
- **Sandbox isolation** — gVisor overhead vs Firecracker-via-`firecracker-containerd`; pick the v1
  line. *Blocks M4 (managed untrusted code).*
- **Wake-on-request latency** — measure cold start (container start + Nitro boot + Workflow replay);
  set idle timeout / warm-pool. *Blocks M2/M4.*
- **Postgres blast radius** — backup/restore drill + warm standby before real customers. *Blocks M4.*
- **eve beta churn** — pin eve versions per repo; isolate an "eve-version adapter" layer. *Ongoing.*

---

## 8. Interfaces to define early (keep OSS == managed)

These seams are what let one codebase serve OSS-BYO and managed. Define signatures before building
either implementation:
- `DeployTarget` — build/provision/deploy/health. OSS: `ContainerPostgres(BYO)`; managed:
  `BareMetalDocker`/`Nomad`.
- `SecretsProvider` — local/no-op (OSS) vs KMS/Vault (managed).
- `ModelGateway` — direct keys (OSS) vs proxy w/ token metering + spend caps (managed).
- `MeteringSink` — no-op (OSS) vs usage-events → Stripe (managed).
- `Scheduler` — fires crons; in managed, **wakes** scaled-to-zero instances.
- `TelemetrySink` / runs store — same UI, local vs remote-OTLP ingestion.

---

## 9. How to run what exists

```bash
cd /Users/aaron/code/eden
npm install
npm run dev        # dev server (note: default port 5173 may be taken; use --port 5199)
npm run typecheck
npm run build
```
Memory of decisions persists at
`/Users/aaron/.claude/projects/-Users-aaron-code-eden/memory/eden-project.md`.
