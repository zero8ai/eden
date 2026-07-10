# Eden — Managed Service Architecture

> Companion to [`PRD.md`](./PRD.md). Covers the **commercial managed offering**: how Eden runs,
> isolates, meters, and bills customer eve agents on infrastructure Eden owns.
> **Status:** Draft v0.1 · **Last updated:** 2026-07-01

---

## 1. First principles (substrate-independent)

These hold no matter what we run on — a cloud provider, a Kubernetes cluster, or a single bare-metal
box. They are what keep the managed service and the OSS product **one codebase**.

1. **Control plane vs. data plane are separate.**
   - *Control plane* = the Eden web app + APIs (GitHub, authoring, PRs, deploy controller,
     scheduler, model gateway, metering, billing, tenancy). It **never runs customer agent code**.
   - *Data plane* = the fleet of running eve instances. In managed mode Eden owns it.

2. **The tenancy unit is one isolated instance per deployed agent — not per customer.**
   In eve, a tool's `execute()` runs **in the host Nitro process** (only `bash`/model-generated code
   goes to the sandbox). Customer-authored tools are arbitrary TypeScript, so the host process runs
   untrusted per-customer code. Tenants therefore **cannot share a process or, ideally, a kernel**.

3. **Two isolation layers:**
   - *Instance boundary* — isolates customer A's tool code from customer B (tenant trust boundary).
   - *Sandbox boundary* — isolates model-generated code from the instance it runs in.

4. **Compute ⟂ state (this is the money-saver).** eve sessions are durable via the Workflow SDK; a
   parked agent (waiting on a message, an approval, or a cron) consumes **zero compute**. The durable
   event log lives in **Postgres**, fully decoupled from the compute. So idle instances can be
   **stopped**, and on the next event they **replay from Postgres and resume**. Most agents are idle
   almost always → density comes from packing *stopped* instances, and cost is driven by *concurrent
   active* turns, not total agents.

5. **Managed = OSS + provider implementations.** Everything below hangs off interfaces the OSS
   product already defines: `DeployTarget`, `SecretsProvider`, `ModelGateway`, `MeteringSink`,
   `Scheduler`. OSS ships local/no-op/BYO versions; managed ships the real ones. **No fork.**

---

## 2. The substrate: one bare-metal box, many Docker containers

**Decision:** v1 managed runs on a **single dedicated bare-metal server** (target ~$200–1,000/mo
class, e.g. a 48+ core / 256 GB Hetzner-style dedicated box), packing **many Docker containers** —
one per deployed agent instance, plus sandboxes and control-plane services. We explicitly **avoid**
per-VM cloud platforms (Fly/Firecracker-as-a-service) for cost reasons. Bare metal is chosen
deliberately: it exposes **KVM**, so we can still get microVM-grade isolation *ourselves* when we
want it (§2.2) — something most cloud VPS products forbid (no nested virt).

### 2.1 Orchestration on the box

| Option | Verdict |
|---|---|
| **Nomad** (single static binary, Docker driver, gVisor/Kata task drivers) | **Recommended.** Runs great on one node, gives scheduling/placement/health/restart for free, and makes the eventual **1→N box** jump trivial (add a node, it schedules across them). Low ops overhead vs. K8s. |
| **Plain Docker Engine API** (deploy controller calls the daemon directly) | Fine **fallback / M-first**: zero extra moving parts. Start here if Nomad is friction; migrate to Nomad when we outgrow one box. |
| **K3s / Kubernetes** | Overkill for one box; adopt only if we standardize on K8s later. Behind the same `DeployTarget` seam regardless. |

The **deploy controller** (control plane) is the only thing that talks to the orchestrator. It's an
implementation of `DeployTarget` — `BareMetalDockerTarget` (or `NomadTarget`).

### 2.2 Isolation — the part that matters on a shared kernel

Plain Docker shares the host kernel; that is **too weak** for untrusted model-generated code. On bare
metal we have the full menu:

| Layer | v1 | Hardening upgrade |
|---|---|---|
| **Instance container** (customer tool code) | **gVisor (`runsc`)** runtime — userspace-kernel syscall isolation, high density, low overhead | Kata if a tenant needs VM-grade isolation |
| **Sandbox** (model-generated `bash`/scripts) | **gVisor**, or a dedicated ephemeral sandbox container per exec | **Kata / Firecracker via `firecracker-containerd`** — real microVMs, available because bare metal gives us KVM |

v1 pragmatic default: **gVisor for both layers**, sandbox containers are **ephemeral** (created per
exec/session, destroyed after). Upgrade the sandbox layer to Firecracker microVMs once we're handling
genuinely hostile workloads. This is a config choice at the runtime level, not an architecture change.

### 2.3 Scale-to-zero + wake-on-request (without a cloud)

We reproduce Fly's "sleep when idle, wake on request" on our own box:

- **Sleep:** the deploy controller / scheduler **stops** (not removes) an instance container after an
  idle timeout. A stopped container uses **0 CPU, 0 RAM** — only disk (image layers + its writable
  layer). State is safe because the Workflow event log is in Postgres, not the container.
- **Wake-on-request:** an on-demand reverse proxy starts the stopped container on the next inbound
  request, then forwards once healthy. **[Sablier](https://github.com/sablierapp/sablier)** does
  exactly this with Traefik/Caddy/nginx; or we build a thin wake-proxy. First request after sleep
  eats a cold-start (~container start + Nitro boot + Workflow replay); subsequent requests are warm.
- **Scheduled wake:** a sleeping instance can't fire its own cron, so the **control-plane scheduler**
  (§3.3) wakes the container at the scheduled time to run the turn, then lets it idle back to sleep.

### 2.4 Density / capacity model (why one box goes far)

- **Idle (stopped) instance:** ~0 CPU/RAM; cost = disk for image + writable layer. Thousands fit.
- **Active turn:** a burst of CPU + a few hundred MB RAM for the Node/Nitro process (+ sandbox when
  code runs). Concurrency is bounded by **active** turns, not total agents.
- **Back-of-envelope:** 256 GB box, ~512 MB per active instance ⇒ ~**500 concurrent active turns**;
  total *hosted* agents in the thousands because the idle ones are stopped. Disk (images + Postgres +
  layers) becomes the first real ceiling — mitigate with a shared base image and layer dedup.

---

## 3. Control-plane components

Same box (as containers) for v1; logically the control plane, and separable onto its own host later.

### 3.1 Deploy controller (`DeployTarget`)
Runs the pipeline on merge: `eve build` → package image → push to a **local registry** on the box →
provision the instance's Postgres DB + secrets → `docker run` (via Nomad/Docker API) with the chosen
gVisor/Kata runtime → wire ingress → health-check. Handles rollback (previous image tag) and
stop/start for scale-to-zero.

### 3.2 Model gateway (keys · metering · caps)
Off-Vercel there is no AI Gateway, so we run our **own proxy** (LiteLLM-class or a thin service) that
every instance's model calls route through. It is the single place where we:
- **own provider keys** (customers never see them),
- **meter tokens** per instance (metering chokepoint #1),
- **enforce per-tenant spend caps / rate limits** and kill-switches.

### 3.3 Scheduler
Owns all cron/`schedules` for managed instances. Fires at the scheduled time, **wakes** the target
instance (§2.3), triggers the turn. Central because sleeping instances can't self-fire. Durable (backed
by the control-plane DB / a queue) so a box reboot doesn't drop schedules.

### 3.4 Metering + billing
Three capture chokepoints → metering store → Stripe:
- **Model tokens** — from the model gateway (§3.2).
- **Compute-seconds** — from the orchestrator / cgroup accounting (`docker stats` / Nomad metrics)
  per instance.
- **Sandbox execution** — from the sandbox runtime (exec count / duration).
Events land in Postgres (ClickHouse only if volume demands), aggregate into usage, push **Stripe
usage records**. Plans + usage-based billing on top. We pay the box + model providers, mark up.

### 3.5 Secrets
KMS-backed (or Vault) secret store; encrypted at rest; injected as **container env at start**; scoped
per instance/environment; **never written to the repo**. The authoring assistant references secrets by
name only.

### 3.6 Ingress / routing
A reverse proxy (**Caddy or Traefik**) on the box with **wildcard TLS** (`*.eden.app`), routing
`agent-<id>.eden.app` → the instance container, integrated with the wake-proxy (§2.3). Also terminates
channel webhooks (Slack/HTTP) per instance. **Discord (issue #32)** is the exception: one
Eden-owned Discord app serves the whole installation, so its single Interactions Endpoint URL
points at the **control plane** (`/api/discord/interactions`), which verifies the signature and
relays each interaction to the bound agent instance's Discord channel — the shared bot token
never reaches an instance.

**Version-aware traffic splitting (§3.9, PRD §7.7 — data plane only since M5.6).** The data model
admits **multiple Releases live at once** in one environment; the proxy does **weighted,
session-sticky** routing across their instance containers: a weight per Release (e.g. 90/10 canary
or 50/50) and a **session pin** (cookie / `x-eve-session-id` / channel thread id) so a conversation
stays on one version for its whole life — you cannot flip an agent mid-turn. Wake-on-request
composes with this (each Release's container sleeps / wakes independently). Runs are version-tagged
(§3.7), so per-version telemetry comparison is free. **Product model since M5.6:** the deploy
controller enforces a single live Release per environment (a deploy that lands healthy demotes the
rest), so the splitter trivially routes to one instance until a multi-version surface returns.

### 3.7 Observability / run-observability subsystem
First-class subsystem (PRD pillar §7.6), not an afterthought — teams must be able to open any agent
and inspect any execution in full. Vercel's Agent Runs is Vercel-only, so Eden ships its own on
**every** deploy target.

**Two ingestion sources (complementary):**
- **eve OpenTelemetry** — `agent/instrumentation.ts` emits AI-SDK spans (tokens, model, latency,
  model/tool I/O). Instances export **OTLP** to an Eden **collector**.
- **Workflow event log** — the durable, replayable per-turn/per-step record in the instance's
  Postgres World. Read by an event-log reader for structure + durability (survives, replayable).
Eden merges both into a normalized **runs store**.

**Ingestion path differs by mode (important):**
- **Managed:** instance and collector are co-located on the box; OTLP is local, cheap.
- **BYO / self-host:** the instance runs in the *customer's* account, so it must **ship telemetry to
  Eden's collector over an authenticated OTLP endpoint** (per-instance ingest token). This is the one
  genuinely new architectural surface observability adds — a public, authenticated OTLP receiver +
  per-instance credentials.

**Runs store & data model** (Postgres now; **ClickHouse** if span/event volume demands):
```
Session(id, agent_id, tenant/org_id, trigger, started_at, ...)
  └─ Run(id, session_id, agent_version=git_sha/build_id, trigger_source,
         started_at, ended_at, wall_ms, status, error, tokens_in, tokens_out, cost,
         model(s), tool_call_count, tool_error_count)
       └─ Step(id, run_id, seq, type[model_call|tool_call|reasoning|message],
               started_at, ended_at, duration_ms,
               // model_call: messages_in, output, tokens, model
               // tool_call:  tool_name, input, output, error, approval_gated
               ...)
```
- **System prompt = link, not (only) snapshot.** Each Run stores the **deployed `git_sha`/build id**;
  Eden reconstructs the exact system prompt (`instructions.md` + tools + skills) from the repo at that
  commit. Optional resolved-prompt snapshot for immutability. **User input, tool I/O, tokens, timing
  are runtime data and are always recorded.**
- **UI:** *Agent → Run list* (summary metrics) → *Run transcript* (progressive-disclosure timeline).

**Cross-cutting:**
- **Access control** via WorkOS roles — transcripts hold sensitive prompt/response data.
- **Tenant isolation** of telemetry in managed mode (org-scoped store + queries).
- **Retention + redaction** policies; deployer-disclosure note per eve guidance.
- **Relationship to metering (§3.4):** the model gateway remains the **billing** source of truth for
  tokens; observability is the **per-run detail** view. Reconcile, don't double-count.

### 3.8 Tenancy & auth (WorkOS AuthKit)
Authentication and the tenancy model are delegated to **WorkOS AuthKit**, scaffolded once with
`npx workos@latest install` (detects React Router 7, installs the SDK, generates OAuth callback + middleware,
configures redirect URIs/CORS in the WorkOS dashboard, writes `.env.local`, validates the build).

- **A WorkOS Organization = an Eden tenant.** Orgs, roles, permissions, SSO, directory sync (SCIM),
  and webhooks come from AuthKit — we do **not** hand-roll org/role/SSO/audit-of-identity.
- **OSS install** = a single WorkOS org; **managed** = many orgs, one per customer. Same code path.
- Eden's own tables hold only what WorkOS doesn't: spend limits, per-tenant deploy/billing metadata,
  and the operational audit log (deploys, secret changes) — keyed by WorkOS org/user IDs.
- Prereqs: Node 20+, a WorkOS account. Instance-level agent auth (channel route-auth secrets) is
  separate and lives in the secrets store (§3.5).

### 3.9 Release registry & versioning (PRD §7.7)
eve has no native versioning; Eden layers one over git. A **Release = an immutable build at a merge
commit** — `{ label (v1/v2…), commit_sha, image_digest, changelog, author, created_at }`. Immutability
is inherited: git commits + content-addressed images, nothing engineered.

- The **deploy controller** (§3.1) records a Release per build and keeps the image (already retained
  for rollback). **Fast rollback** = re-point an environment/split to a prior Release's image (no
  rebuild); **git revert** = an undo PR through the normal pipeline.
- An **environment maps to one or more active Releases with weights** (the split config the ingress
  proxy §3.6 enforces). Running multiple versions live is the core product primitive — Eden does
  *not* ship an automated A/B/experimentation engine; per-version telemetry (§3.7) is how humans judge.
- **Immutability caveat:** a Release pins repo state (config/tools/skills/instructions), **not**
  secrets/env (they live outside git). Version secret *metadata/generation* only — never values — for
  faithful "what ran then".

---

## 4. Per-instance dependencies (managed)

| Dependency | Managed implementation |
|---|---|
| **Workflow World** | **Self-run Postgres** on the box (or a dedicated DB box), **database-per-instance** for hard data isolation. Postgres is eve's reference World; running our own is cheap and removes the Neon/cloud dependency. |
| **Sandbox backend** | gVisor (v1) / Kata-Firecracker (hardened) ephemeral containers, per §2.2. |
| **Secrets** | Injected env from §3.5. |
| **Model access** | Routed through the model gateway §3.2 (direct provider keys, no AI Gateway). |
| **Ingress** | Per-instance subdomain via §3.6. |

---

## 5. Deploy pipeline (managed, on merge)

```
PR merged ──► Deploy Controller:
  1. eve build            → .eve/ + Nitro .output/
  2. docker build         → image (shared base layer)
  3. push                 → local registry on the box
  4. provision            → create instance Postgres DB, load secrets as env
  5. run                  → Nomad/Docker: start container w/ gVisor runtime
  6. release              → record Release {commit_sha, image_digest, label, changelog}
  7. route                → Caddy/Traefik subdomain + wake-proxy + weighted split config
  8. health + smoke       → mark live; keep previous Release image for fast rollback
  9. idle                 → scheduler stops container after idle timeout
```
The data plane admits multiple live Releases per environment (§3.6/§3.9), but since M5.6 the
controller enforces single-live: step 8's "mark live" also demotes the environment's other live
deployments (cutover on health — a failed deploy leaves the old version serving). Rollback ("Make
live" on a prior Release) is the same path with the retained image — seconds, no rebuild.

---

## 6. Reliability & the single-box tradeoff

Running on one box is a deliberate cost tradeoff. Honest accounting:

- **No HA in v1** — the box is a single point of failure. Acceptable for early managed customers;
  set expectations in the SLA.
- **State survives crashes.** Because durability lives in Postgres (compute ⟂ state), a box reboot
  loses only *in-flight compute* — sessions **replay from the event log and resume**. This is a big
  win of eve's model and must be protected.
- **Protect Postgres above all.** It is the durable truth for every agent. Put it on its own
  disk/volume, enable WAL archiving, and **stream backups to object storage** (S3/B2). Ideally a
  warm standby (second cheap box or managed replica) even before full compute HA.
- **Disk is the sleeper risk.** Images + writable layers + Postgres + backups. Monitor and GC old
  images/stopped-container layers; use a shared base image.

---

## 7. Scaling path (1 → N boxes)

The architecture is designed so growth is "add a box," not "re-platform":

1. **One box, Docker API** — simplest start.
2. **One box, Nomad** — same box, better scheduling/health; drop-in.
3. **N boxes, Nomad cluster** — Nomad schedules instances across nodes; ingress/wake-proxy front the
   cluster; **Postgres moves to a dedicated DB host** (or managed) and instance DBs shard across it.
4. **Elastic / multi-region** — introduce additional `DeployTarget` implementations (a cloud target,
   K8s) *alongside* bare metal for burst or geo — the seam already exists.

Nothing in the control plane changes across these steps; only the `DeployTarget` and where Postgres
lives.

---

## 8. Security / threat model (essentials)

- **Untrusted code runs in the data plane, never the control plane.** The gateway, controller,
  scheduler, and secrets store are never in an agent's process.
- **Model-generated code** → ephemeral gVisor/Firecracker sandbox, no host network, no ambient creds,
  egress filtered.
- **Tenant isolation** → gVisor (min) / Kata (hardened) per instance; per-instance Postgres DB;
  per-instance secret scope; network policy between containers.
- **Egress control** on instances/sandboxes to limit data exfiltration and SSRF.
- **Spend/abuse** → per-tenant token + compute caps and kill-switches at the gateway.
- **Secrets** encrypted at rest, injected at boot, never in repo or logs; assistant sees names only.

---

## 9. Diagram

```
┌──────────────────────────  ONE BARE-METAL BOX (v1)  ──────────────────────────┐
│                                                                                │
│  CONTROL PLANE (containers — never runs agent code)                            │
│  ┌──────────────────────────────────────────────────────────────────────┐     │
│  │ Eden web/API · Deploy Controller (DeployTarget=BareMetalDocker/Nomad)  │     │
│  │ Scheduler (wakes instances for crons) · Model Gateway (keys/meter/caps)│     │
│  │ Metering→Billing(Stripe) · Secrets(KMS/Vault) · OTel collector/Runs    │     │
│  │ Local image registry · Tenancy(org/roles/audit)                        │     │
│  └──────────────┬──────────────────────────────┬────────────────────────┘     │
│      provision/ │ start·stop (scale-to-zero)    │ meter                        │
│      wake       ▼                                ▼                             │
│  DATA PLANE (one gVisor/Kata container per deployed agent)                      │
│  ┌───────────────┐ ┌───────────────┐ ┌───────────────┐   ┌──────────────────┐ │
│  │ eve Nitro app │ │ eve Nitro app │ │ eve Nitro app │   │  Postgres        │ │
│  │ +sandbox(gVis)│ │ +sandbox      │ │  (STOPPED =   │◄──┤  (Workflow World,│ │
│  │  [ACTIVE]     │ │  [ACTIVE]     │ │   0 cpu/ram)  │   │  DB-per-instance,│ │
│  └───────┬───────┘ └───────┬───────┘ └───────────────┘   │  durable log)    │ │
│          │                 │                             └──────────────────┘ │
│  Caddy/Traefik + wake-proxy (Sablier) ── *.eden.app ── Slack/HTTP webhooks     │
│                                                                                │
└────────────────────────────────────────────────────────────────────────────────┘
   Backups (WAL + snapshots) ──► object storage (S3/B2)   [protect Postgres first]
```

---

## 10. What changed vs. a cloud-VM substrate

| Concern | Cloud (Fly-style) | Bare-metal Docker (chosen) |
|---|---|---|
| Isolation | microVM per app (native) | gVisor per container; Kata/Firecracker via KVM when needed |
| Scale-to-zero | native wake-on-request | **stop container** + Sablier/wake-proxy |
| Workflow World | managed Postgres (Neon) | **self-run Postgres**, DB-per-instance |
| Orchestration | provider API | **Nomad** (or Docker API) |
| Cost model | pay-per-VM-second | fixed monthly box; near-zero marginal per idle agent |
| HA | multi-node by default | **single box v1**, state survives via Postgres replay; add boxes later |
| Metering compute | provider billing API | cgroup / `docker stats` / Nomad metrics |

Everything above the substrate — control/data-plane split, tenancy unit, compute⟂state, the model
gateway, metering chokepoints, and the `DeployTarget` seam — is **unchanged**. That's the payoff of
putting the substrate behind an interface.

---

## 11. Risks & spikes to de-risk first

1. **Sandbox isolation** for untrusted model code on a shared kernel — validate gVisor overhead vs.
   Firecracker-via-`firecracker-containerd`; pick the v1 line.
2. **Wake-on-request latency** — measure cold-start (container start + Nitro boot + Workflow replay);
   decide idle-timeout and whether to keep a small warm pool.
3. **Postgres blast radius / backup-restore drill** — prove we can restore all instance DBs from
   object storage; decide on a warm standby before real customers.
4. **Density ceiling** — find the real limit (disk, file descriptors, PIDs, Postgres connections) on
   the target box before we promise capacity.
5. **`eve build` headless** — confirm build/init run non-interactively in the controller.
6. **OTel span fidelity for observability** — confirm eve's AI-SDK spans include full tool
   input/output (not just names/timing); if not, supplement from the Workflow event log. Decide the
   normalized runs schema before building the UI.
7. **Authenticated OTLP ingest for BYO** — design the public OTLP receiver + per-instance ingest
   tokens + rate limiting so self-hosted instances can ship runs back without leaking cross-tenant.
```
