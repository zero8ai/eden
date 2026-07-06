# Plan: Team delegation — interagent communication (Milestone 7, runtime half)

> Status: design approved, implementation in progress · Owner: asiraky@gmail.com · 2026-07-06
>
> Closes the open piece of PRD §11 Milestone 7: "auto-generated teammate delegation tools …
> and cross-agent correlation ids → linked traces". Also delivers the product requirement that
> **which agents may talk to which agents is selectable, simply**.

---

## 1. The shape of the feature (decisions + rationale)

### D1. Delegation goes through an Eden relay, not peer-to-peer

A team member's tool calls `POST {EDEN_TEAM_URL}/api/team/ask` on the Eden control plane; the
relay calls the peer's eve HTTP session API and returns the peer's final reply synchronously.

Why not direct peer HTTP (the PRD §7.9 sketch):
- Instances bind `http://127.0.0.1:<random host port>` (`deploy.localdocker.server.ts:373-384`)
  — they are *not addressable by each other*, only by the control plane, and the port changes
  on every redeploy. Baking peer URLs into a caller's env goes stale immediately.
- eve session routes have **no authentication** today (scaffolded `placeholderAuth()`); network
  isolation is the security model. A relay keeps that model intact — no new open surface on
  instances.
- The relay is the natural **authorization chokepoint** (the who-can-ask-whom check lives
  server-side, always current) and the natural **correlation point** (it sees both sides of
  every delegation, so linked traces need no eve cooperation).
- The relay reuses `sendTurn()` from `app/agent/talk.server.ts` — the already-hardened
  synchronous eve client (turn attribution, replay guards, failure extraction). The generated
  tool inside the customer agent stays ~60 lines and speaks plain JSON to Eden, not the eve
  protocol.

This is ingress-shaped work (like the splitter), not "control plane runs customer code" — the
relay only forwards a message and drains a stream.

### D2. The tool is baked into the image at build time, not committed to the repo

`buildEveImage`'s `fetchSource` step writes `agent/tools/ask-teammate.ts` into the build
context (never the repo) for **team members only** (`agent.root !== "agent"`), skipping if the
repo already has a file at that path (user override wins).

Precedent: the `eve-docker` shim (M6.2) and the Dockerfile drop-in — Eden-owned runtime
infrastructure ships in the image, not as PR churn in the customer's repo. The tool file is
identical for every member and every roster (all variability arrives via env), so images stay
reusable across redeploys.

### D3. Roster/identity arrive via env at deploy; permissions are enforced live at the relay

Injected by the controller for team members (stripped from user secrets first, same
anti-shadowing rule as `EDEN_SANDBOX_ENV`):

- `EDEN_TEAM_URL` — relay base URL reachable from inside the container
  (default `http://host.docker.internal:<Eden PORT>`, override `EDEN_TEAM_RELAY_URL`).
- `EDEN_TEAM_TOKEN` — HMAC-signed token identifying the **deployment** (relay derives
  environment → agent → project from the DB; nothing else trusted from the client).
- `EDEN_TEAMMATES` — JSON `[{ name, role }]` of **all other roster members** (not filtered by
  permissions), `role` = first paragraph of the peer's `instructions.md` (cached source read;
  empty on failure — never fail a deploy over a description).

Deliberate split: **discovery** (which teammates the model sees in the tool description) is
deploy-time env; **authorization** (which asks are allowed) is checked live in the DB on every
relay call. Toggling a permission therefore takes effect *instantly* with no redeploy; a
disallowed ask returns a clear error the model can relay.

### D4. Permissions: default-allow, directed overrides in one table

`agent_links(projectId, fromAgentId, toAgentId, enabled)` — a row exists only for pairs the
user has touched; **absent row = allowed**. This avoids seeding, avoids backfill migrations,
avoids resurrecting deleted links on roster self-heals, and new members can collaborate
immediately (PRD: "auto-wired"). The UI is a simple directed matrix on repo-level Settings
(team repos only): each row "X can ask:" with a checkbox per other member, fetcher-based
toggles (secrets-card pattern). Self-asks are always rejected.

### D5. One ask = one fresh peer session, synchronous, self-contained

`ask-teammate(teammate, message)` → relay POSTs a **new** eve session on the peer (multi-turn
`continuationToken` semantics are unproven — SPIKE-EVE.md:82-84), waits for the turn to settle
(`sendTurn`), returns the final reply text. The tool description instructs the model to write
self-contained requests. The relay prefixes the message with one provenance line:
`From your teammate "<caller name>": `. If the peer's turn parks on `input.requested`
(question/approval), the relay returns `ok:false` with the request text — human-input gates do
not compose across delegation in v1 (PRD §12 punt, now explicit).

### D6. Correlation: a `delegations` table + relay-recorded peer runs

The relay records the peer's run itself via the existing `recordTurnStart`/`recordTurnFinish`
(channel `"teammate"`, metadata `{ delegationId, fromAgentId, fromAgentName }`) and writes a
`delegations` row (from-agent/env, to-agent/env, peer session id, status, timing). The relay
response includes the peer's Eden run id + UI path; the tool returns it, so the caller's
transcript tool-step links to the peer's run, and the peer's run header links back to the
caller. Linked traces with zero changes to the runs schema.

### D7. Roster changes refresh teammates automatically

`EDEN_TEAMMATES` is deploy-time env, so adding/removing a member must refresh the *other*
members: after a merge-driven roster sync changes membership, Eden queues a redeploy (image
reuse, no rebuild) of every other member's live deployments. This is the PRD's "kept in sync
as the roster changes".

### Deliberately punted (record in PRD)
- Approval gates across a delegation chain (relay surfaces the parked request as an error).
- Wake-on-delegation for stopped instances (OSS has no auto-idle-stop; error is actionable).
- Multi-turn teammate conversations (continuation contract unproven upstream).
- Streaming intermediate progress into the caller's transcript.
- Cross-repo delegation (teams are one repo by definition).
- Precise chain-depth tracking; runaway loops are bounded by concurrency caps + timeouts.

---

## 2. Runtime flow

```
caller instance                       Eden control plane                    peer instance
──────────────                        ──────────────────                    ─────────────
model calls ask-teammate(
  teammate:"deployer",
  message:"Deploy build 42")
  │
  └─ POST {EDEN_TEAM_URL}/api/team/ask
     Authorization: Bearer {EDEN_TEAM_TOKEN}
     { teammate, message }
                                      1. verify token → deployment → env → agent → project
                                      2. resolve target agent by (projectId, name)
                                      3. authz: agent_links default-allow check; no self-ask
                                      4. caps: active delegations per edge (3) + project (10)
                                      5. target env = same *name* as caller's env
                                         (ship fan-out convention); must have a live deployment
                                      6. insert delegations row (running)
                                      7. sendTurn({ baseUrl: peer.url,
                                           message: `From your teammate "pm": …` })
                                                                            eve session runs
                                      8. recordTurnStart/Finish (channel "teammate")
                                      9. update delegations row; respond
     ← { ok, reply, teammate, sessionId, runId, runPath }
  │
  └─ tool returns that object → recorded as the caller's tool_call step
```

Timeouts: relay `EDEN_DELEGATION_TIMEOUT_MS` (default 600 000); tool fetch = relay + 60s.
Concurrency caps count `delegations` rows with `status='running' AND startedAt > now - (timeout + 60s)`
so crashed rows can't wedge the caps.

---

## 3. Schema (drizzle, follow existing conventions exactly)

```ts
/** Directed collaboration overrides. Absent row = allowed (default-allow). */
export const agentLinks = pgTable("agent_links", {
  id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
  projectId: varchar("project_id", { length: 12 }).notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  fromAgentId: varchar("from_agent_id", { length: 12 }).notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  toAgentId: varchar("to_agent_id", { length: 12 }).notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull(),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [uniqueIndex("agent_links_pair_uq").on(t.fromAgentId, t.toAgentId)]);

/** One row per teammate ask — the cross-agent correlation record. */
export const delegations = pgTable("delegations", {
  id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
  projectId: varchar("project_id", { length: 12 }).notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  fromAgentId: varchar("from_agent_id", { length: 12 })
    .references(() => agents.id, { onDelete: "set null" }),
  fromEnvironmentId: varchar("from_environment_id", { length: 12 }),
  toAgentId: varchar("to_agent_id", { length: 12 })
    .references(() => agents.id, { onDelete: "set null" }),
  toEnvironmentId: varchar("to_environment_id", { length: 12 }),
  externalSessionId: text("external_session_id"), // peer eve session
  runId: varchar("run_id", { length: 12 }),        // peer Eden run row
  status: text("status").notNull().default("running"), // running|completed|failed
  error: text("error"),
  startedAt: createdAt(), finishedAt: timestamp("finished_at", { withTimezone: true }),
}, (t) => [index("delegations_project_started_idx").on(t.projectId, t.startedAt)]);
```

Migration via `npm run db:generate` (no data backfill needed — default-allow). Extend the
`DataStore` ports (`app/data/ports.ts`) + drizzle impl with the minimal methods the feature
needs (list/toggle links; insert/update/count-active delegations).

---

## 4. Implementation map (files)

| Area | File | Work |
|---|---|---|
| Schema | `app/db/schema.ts`, `drizzle/` | Tables above + generated migration |
| Ports | `app/data/ports.ts`, `app/data/drizzle.server.ts` | `agentLinks` + `delegations` repos |
| Token | `app/team/token.server.ts` (new) | HMAC sign/verify over deploymentId (reuse the secrets key source); token format `ednt_<deploymentId>.<sig>` |
| Roster env | `app/team/roster.server.ts` (new) | `teammateRoster(project, selfAgentId)` → `[{name, role}]` from cached source (`fetchAgentSource`); first-paragraph extraction, 200-char cap |
| Relay | `app/routes/api.team.ask.ts` (new) + `app/team/ask.server.ts` (new) + `app/routes.ts` | The §2 flow; thin route, testable server module; reuse `sendTurn`, `recordTurnStart/Finish`, `liveTargets`-style deployment resolution |
| Tool template | `app/team/tool-template.ts` (new) | The generated `ask-teammate.ts` source string (see §5) |
| Build injection | `app/deploy/eve-image.server.ts` | Write tool file into build context when `BuildRequest` says team member; don't clobber an existing user file; new optional field on `BuildRequest` (`app/seams/types.ts`) set by the controller |
| Env injection | `app/deploy/controller.server.ts` | Strip + set `EDEN_TEAM_URL` / `EDEN_TEAM_TOKEN` / `EDEN_TEAMMATES` for team members (roster > 1), next to the `EDEN_SANDBOX_ENV` handling |
| Roster refresh | `app/deploy/ship.server.ts` + webhook path | After membership change, queue same-release redeploys of other members' live deployments |
| Settings UI | `app/routes/projects.$projectId.settings.tsx` (+ small component) | Repo-level "Team collaboration" section, `showRepo && team`, directed checkbox matrix, fetcher intents |
| Team landing | `app/routes/projects.$projectId.tsx` | Replace the "Coming next: delegation channels" tease with the real state |
| Transcript link | `app/components/run-steps.tsx` | `ToolCall` branch for `ask-teammate`: "Asked <teammate>" + link via `data.output.runPath` |
| Run header link | `app/routes/projects.$projectId.runs.$runId.tsx` | "Triggered by <fromAgentName>" chip when `run.metadata.delegationId` present |
| Docs | `PRD.md` | M7 runtime half → shipped (what/why/punts), resolve the §12 "Teammate delegation semantics" open question |

---

## 5. The generated tool (shape contract)

Static file, env-driven, no deps beyond `eve/tools` + `zod` (both already in every member's
package.json). Module-load code must be crash-proof: malformed/absent env → empty roster, tool
still defines cleanly.

```ts
import { defineTool } from "eve/tools";
import { z } from "zod";

const teammates = safeParse(process.env.EDEN_TEAMMATES); // [{name, role}]
const names = teammates.map((t) => t.name);

export default defineTool({
  description: buildDescription(teammates), // enumerates each teammate + role; tells the
                                            // model asks must be self-contained (the teammate
                                            // cannot see this conversation); reply is final
  inputSchema: z.object({
    teammate: names.length ? z.enum(names) : z.string(),
    message: z.string().describe("A complete, self-contained request…"),
  }),
  async execute({ teammate, message }) {
    // POST `${EDEN_TEAM_URL}/api/team/ask`, Bearer EDEN_TEAM_TOKEN, AbortSignal.timeout(…)
    // Return the relay JSON verbatim on success; return { ok:false, error } on any failure
    // (never throw — the model should read and adapt).
  },
});
```

---

## 6. Testing

- Unit: token sign/verify (tamper, wrong key), default-allow link logic, roster/first-paragraph
  extraction, relay authz + caps + env-name resolution (mock store + `sendTurn`), tool template
  (evaluates under the env contract: with/without `EDEN_TEAMMATES`).
- Follow existing vitest patterns in `tests/unit/`; `npm run typecheck` (or the repo's check
  script) and the full test suite must pass.
