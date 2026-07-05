# Plan: Secrets Management Rework

**Status:** planned, not started. **Audience:** the implementing agent — this doc is self-contained; read the cited files before coding. Line numbers were verified 2026-07-05 against an uncommitted working tree and may drift; anchor on symbol names, not lines.

## 1. Problems being fixed (product owner's gripes)

1. Secret rows show only a bare name — no way to tell what/when a value was set, no affordances.
2. Save/delete are document `<Form>` + server `redirect` → **full page reload** per mutation; inputs "clear" only because the route remounts. Janky.
3. Sandbox exposure can only be toggled **after** a secret exists (second round-trip).
4. Marketplace templates declare required secrets, but nothing in Settings shows "this agent still needs `CLOUDFLARE_API_TOKEN`", and deploy proceeds silently with missing secrets.
5. Installing an **agent** template renders the secret inputs **disabled** ("set after the member ships") — users must know to go set them later.
6. **NEW:** secrets shared across agents (e.g. `GITHUB_TOKEN`) must be re-entered per agent. Want project-level shared secrets with **per-agent opt-in**.

A full UX spec was produced for this rework; its decisions are folded into §4–§9 below and the wireframes/copy are in §10.

## 2. Current state — verified map

### Storage & crypto
- Two tables in `app/db/schema.ts`:
  - `secretValues` (~L410): `projectId, agentId (NOT NULL), environmentId (nullable), key, ciphertext, iv, authTag, updatedAt`. Unique `(agentId, environmentId, key)` `nullsNotDistinct`.
  - `secretsMetadata` (~L253): same scope columns + `sandboxExposed boolean default false`, `updatedBy, updatedAt`. Same unique key. Control-plane policy lives here, deliberately separate from values (survives provider swaps).
- `environmentId = null` means **agent-wide** (all of that agent's envs), NOT project-wide. There is **no project-level secret concept today** — `agentId` is NOT NULL everywhere, and the schema comment (~L118) hard-commits "everything keys by agent, never by project".
- KV store `app/seams/oss/secret-store.ts`: `drizzleSecretKV` — `upsert` (writes both tables), `getSealed`, `delete` (both tables), `listKeys`, `listForResolve` (agent-wide rows first, then env rows so env overrides). Sandbox helpers: `setSecretSandboxExposed`, `listSandboxExposure` (exact scope → `Record<key,bool>`), `listSandboxExposedNames` (deploy scope: agent-wide OR env rows where exposed).
- Provider `app/seams/oss/secrets.local.server.ts`: `makeLocalSecretsProvider(kv, getKey)` — AES-256-GCM via `app/seams/oss/secretbox.ts` (`decodeKey`/`seal`/`open`). Seam interface `SecretsProvider` in `app/seams/types.ts` (~L142): `set/get/delete/listNames/resolve`; `SecretScope = { projectId, agentId, environmentId|null }`.
- **Write-only stance:** `provider.get` is called by nothing in `app/` (only unit tests). `resolve` (plaintext) is called only at deploy (`app/deploy/controller.server.ts` ~L227) to inject container env. **This stance is preserved — do NOT add a reveal endpoint.**

### Settings UI (`app/routes/projects.$projectId.settings.tsx`)
- `SecretsSection` (~L810–949), member-level only (`showMember`, ~L734). Repo-level settings has no secrets UI.
- Loader (~L306–323): `secrets.listNames(scope)` + `listSandboxExposure(scope)` → `{name, sandboxExposed}[]`. Scope from `?env=` via `resolveScope`; `"all"` sentinel = agent-wide.
- Env switching is a GET `<Form>` + "Switch" button (~L843) — full navigation.
- Create/delete: document `<Form method=post>` intents `secret-set` / `secret-delete` (action ~L516–543), key regex `/^[A-Za-z_][A-Za-z0-9_]*$/`, ends `throw redirect(...)` (~L542) → **full loader re-run** (re-fetches GitHub source, drafts, catalog, envs…). This is the jank.
- Sandbox toggle `SandboxExposeToggle` (~L1077) is the one good citizen: `useFetcher`, optimistic, intent `secret-expose` returns `{ok:true}` with no redirect. **Use this as the pattern for everything.**

### Deploy-time env assembly (`app/deploy/controller.server.ts` ~L247–256)
`resolve(scope)` → env vars; then `delete envVars.EDEN_SANDBOX_ENV` (anti-squatting); `exposed = sandboxExposedNames(scope)` filtered to names that actually resolved; joined into `EDEN_SANDBOX_ENV` (names only). Consumer: scaffolded `sandbox.ts` (`DEFAULT_SANDBOX_MODULE`, `app/eve/templates.ts` ~L171) splits the var and forwards exactly those into the sandbox env. Keep all of this intact, including squatting protection.

### Marketplace
- Manifest schema `app/marketplace/manifest.ts`: `templateManifestSchema.secrets = [{ name (UPPER_SNAKE, ^[A-Z][A-Z0-9_]*$), description?, sandbox? }]` (~L74–83). Concrete: `cloudflare-deployment-engineer` has 4 secrets all `sandbox:true` (the user's "four text boxes"); `cloudflare-deploy` tool has 2. Secrets are in each `template.json` only, not `catalog/index.json`.
- Install route `app/routes/marketplace.$type.$id.install.tsx`: two shapes — tool/skill/subagent → existing member (`target.kind:"member"`); agent → **new member** (`"new-member"`). Secrets inputs render for both but are `disabled={newMemberTemplate}` with placeholder "set after the member ships" (~L560–605). Root cause: the action (~L440–470) writes secrets only when `secretAgent` is set, which only happens in the member branch — a new member has no `agents` row until it ships, so there's no `agentId` to key the secret to.
- Install planner `app/marketplace/install.server.ts` `planInstall`: forwards secret metadata onto the plan; "values never touch the plan" — keep that property.
- **Install lock `app/marketplace/lock.ts` `installEntrySchema` (~L28–45) has NO `secrets` field** — once installed, nothing records what a template required. No missing-secret validation exists anywhere (Settings or deploy).

### Project ↔ agent model
`projects` = the GitHub repo (one project = one repo). `agents` table (`schema.ts` ~L122): one row per roster member, `projectId` FK, unique `(projectId, name)`; single-agent repos are a "team of one" (`name:"agent"`, `root:"agent"`). Roster helpers in `app/project/agent-context.server.ts` (`listAgents`, `isTeamRoster`, `resolveAgentContext`).

## 3. Non-goals / invariants

- **No reveal.** Values remain write-only end-to-end. No endpoint may return plaintext to a client. The UX substitute is fingerprint + set-metadata (§5).
- **No rename.** A secret's name is its env-var contract; rotate = replace value; rename = add+delete.
- Keep the `SecretsProvider` seam shape workable for the managed edition (KMS/Vault swap). New metadata (fingerprint, attachments) lives in control-plane tables, not inside the provider.
- Keep `EDEN_SANDBOX_ENV` names-only + squatting deletion.
- Marketplace plan stays value-free (`planInstall` pure).

## 4. Data model changes (migrations)

### 4.1 Fingerprint + set-audit on `secretsMetadata`
Add `fingerprint text` (full SHA-256 hex of the plaintext value, computed server-side at write time in the same code path as `seal`). `updatedBy`/`updatedAt` already exist — surface them as "Set <relative> by <user>". Compute in `makeLocalSecretsProvider.set` → pass to `kv.upsert` (extend `SecretKVStore.upsert` signature). Backfill: existing rows get `fingerprint = null`; UI renders "fingerprint unavailable — set before fingerprints existed" until next replace.

### 4.2 Project-level shared secrets — nullable `agentId`
Make `agentId` **nullable** on both `secretValues` and `secretsMetadata`; `agentId = null` ⇒ project-level ("shared") secret. Widen both unique constraints to `(projectId, agentId, environmentId, key)` `nullsNotDistinct` (projectId must join the key once agentId can be null). Update `SecretScope.agentId` to `string | null` in `app/seams/types.ts` and chase the type through `secret-store.ts`, `secrets.local.server.ts`, and all callers. Audit every call site that assumes non-null `agentId` (settings action, install action, controller deploy scope) — they all keep passing a concrete agentId except the new shared-secrets surfaces.

### 4.3 Attachments (per-agent opt-in)
New table `secret_attachments`:
```
id, projectId FK, agentId FK (NOT NULL), key (text),
sandboxExposed boolean NOT NULL default false,   -- per-attachment, seeded from shared default
createdBy, createdAt
UNIQUE (agentId, key)
```
Attachment is **by name**, covering all env rows of that shared secret (a shared secret may have per-env values; one attachment attaches the name). Per-attachment `sandboxExposed` is the authoritative sandbox flag for shared secrets on that agent — the shared secret's own `secretsMetadata.sandboxExposed` becomes only the **default seeded into new attachments** (never retro-applied).

### 4.4 Pending install secrets (agent-template installs)
New table `pending_secrets`:
```
id, projectId FK, memberName (text — the roster name the install will create),
key, ciphertext, iv, authTag,        -- sealed with the same secretbox
sandboxExposed boolean, createdBy, createdAt
UNIQUE (projectId, memberName, key)
```
Written by the install wizard for new-member installs; **migrated** into `secretValues`/`secretsMetadata` (agent-scoped, `environmentId:null`) at the moment the member ships and its `agents` row is created; **deleted** if the install/draft is abandoned. Find the ship point by tracing where the new-member install's agent row is inserted (follow the `new-member` branch of the install action → drafts/ship flow in `app/drafts/drafts.server.ts` / deployments route); wire migration + a cleanup on draft abandonment there.

### 4.5 Install lock records requirements
`installEntrySchema` in `app/marketplace/lock.ts` gains optional:
```
secrets: [{ name, description?, sandbox? }]
```
Snapshot of `manifest.secrets` written at install time. Old locks without the field simply produce no required-rows (acceptable). This is what makes "required by template" renderable forever after install and survives template upgrades per-version.

## 5. Resolution & sandbox semantics (single source of truth)

Precedence, most-specific wins:
1. agent + specific env
2. agent, all envs (`environmentId:null`)
3. shared + specific env — **only if attached**
4. shared, all envs — **only if attached**

Implement in `secret-store.ts`:
- `listForResolve(scope)`: fetch attached shared rows (join `secret_attachments` on `agentId` + `key`, rows where `secretValues.agentId IS NULL`), order shared-wide → shared-env → agent-wide → agent-env so later writes override in the merge (`secrets.local.server.ts` `resolve` merge loop keeps working unchanged).
- `listSandboxExposedNames(scope)`: union of (a) existing agent-scoped exposed rows, (b) attachment rows with `sandboxExposed=true` whose shared secret actually exists. Names still filtered at deploy to those that resolved (controller ~L255) — unchanged.
- New helpers: `listSharedSecrets(projectId)` (names + env + fingerprint + updatedAt + attach-count), `listAttachments(agentId)`, `setAttachment(agentId, key, attached, sandboxExposed?)`, `attachmentDependents(projectId, key)` (for delete blast-radius).

Collision rule: an agent-level secret with the same name **overrides** (shadows) an attached shared one; UI marks the agent row "(overrides shared)" and renders the shared row inert ("overridden above", toggle hidden). Deleting the agent override while an attachment exists restores shared behavior (no data change needed — precedence handles it — but toast it in the UI).

## 6. API surface (route actions — no new REST layer)

Stay with route-action intents, but **all mutations become fetcher-JSON: no redirects**. The settings action's `secret-set`/`secret-delete` (~L516) change to `return { ok, secret: { name, fingerprint, updatedAt, sandboxExposed, environmentId } }` / `{ ok }`, plus typed error payloads `{ ok:false, error }` (keep the key-regex and non-empty-value validation server-side). `secret-expose` already returns JSON — leave it.

New intents on the settings action (member level): `secret-attach` / `secret-detach` (`key`, `sandboxExposed` for attach), `secret-replace` (same as set; separate intent only if useful for audit copy). New intents at **repo level** (Shared Secrets section, same route file at repo scope or its own section component): `shared-secret-set`, `shared-secret-delete` (must return dependents list for the confirm dialog — expose a loader-side `dependents` per shared key instead, so the dialog can render before submitting), `shared-secret-expose-default`.

`secret-set` gains an `exposed` field so **sandbox is set atomically at creation** (write metadata row with `sandboxExposed` in the same upsert — kills gripe #3).

Loader changes (member level): return, in one pass —
- all secret rows for the agent **across all envs** (not just the `?env=` scope — env switching becomes client-side filtering, §7),
- shared secrets of the project + this agent's attachments,
- required-secrets: union of lock entries' `secrets` for installs targeting this member (read the lock; join against set/attached names to compute `missing`),
- each row: `{ name, environmentId, sandboxExposed, fingerprint, updatedAt, updatedBy }`.

## 7. Settings UI rework (`SecretsSection` → new component tree)

Follow the UX spec (§10 wireframe). Structure the card into four groups: **Required by template** (missing only) → **This agent's secrets** → **Shared with project** (opt-in toggles) → **Add form**. Plus a collapsed "Dismissed requirements (n)".

- **Env pills** replace the GET switcher: `All | Production | …` as client state synced to `?env=` via `history.replaceState`/`useSearchParams` **without navigation**. Non-matching rows dim (don't hide), keep their env badge.
- **Row anatomy** (all groups share it): mono name · fixed `••••••••` (8 dots, never length-proportional) · env badge · metadata line `Set 12d ago · fp a3f9c2` (first 6 hex of fingerprint; click copies full; tooltip per copy library) · copy-**name** icon · sandbox checkbox · overflow (Replace value…, Delete / Manage in Shared Secrets, Override with agent-specific value…).
- **Replace value:** inline row expansion (password input + Save/Cancel), optimistic metadata swap to `Set just now`, confirm copy "old value can't be recovered". Uses `secret-set` under the hood.
- **Add form** (inline, always visible, bottom of card): Name (auto-uppercase + `_` for spaces, live; validate regex on blur) · Value (`type=password`, show/hide eye **during entry only**) · Env select (defaults to active pill) · **Sandbox checkbox** (in-form — gripe #3) · Add.
  - Live collision check: same name+env agent secret → error + point at Replace; name matches a shared secret → warning + "Attach shared secret instead" link-button.
  - **Submit = useFetcher:** inputs clear immediately on submit, focus returns to Name (rapid multi-add). Optimistic row appears at top of the agent group at 60% opacity, `Saving…`; success → full opacity + fingerprint fills in + ~1s highlight, **no toast**; error → row converts to an error row (red border, server message, Retry/Discard — fetcher retains payload; never dump the value back into the form). Multiple in-flight adds allowed (fetcher per pending row).
- **Required rows** (amber left border, `⚠ Required — not set`, description from lock, "required · <template-id>", `+1` when multiple sources): inline value input **in the row**, name fixed, sandbox pre-checked from manifest ("Sandbox pre-set by template", overridable). Saving transitions the row in place missing→set. If a shared secret with that name exists: primary action **[Attach it]**, secondary "enter an agent-specific value". Never auto-attach (granting a credential must be explicit). Overflow → "Mark as not needed" → moves to Dismissed (recoverable, never hard-deleted). Persist dismissals (small table or a JSON column on the agent row — implementer's choice; must survive reloads and suppress the deploy guard).
- **Shared group:** every project shared secret listed; unattached = dimmed + toggle off + "Project secret · not attached"; attach toggle optimistic (pattern = existing `SandboxExposeToggle`), on attach seed per-attachment sandbox from the shared default and show it as "(this agent)". Detach while a template requires it → inline warning, still allowed. No Replace/Delete at agent level for shared rows.
- **Member list badge:** agent card header in Team Members shows `N secrets missing` (amber) when required-missing > 0.
- **Section note + Why popover:** copy library §10. Delete also converts to fetcher (optimistic row removal, error restores row).

## 8. Shared Secrets section (repo-level settings)

New section on repo-level settings (visible for team repos AND single-agent repos — a team of one still benefits when it grows). Same row anatomy + add form (with "Sandbox default" checkbox, captioned "default for new attachments only"). Each row adds `Used by N agents ▾` disclosure listing attached agents + their per-attachment sandbox state, deep-linking to that agent's Secrets card. Replace = rotation: confirm dialog states blast radius ("3 agents use this secret… applies on next deploy"). Delete: confirm dialog lists dependents by name, notes which agents will show missing-required, button label `Delete for N agents`.

## 9. Install wizard + deploy guard

### Install wizard (`marketplace.$type.$id.install.tsx`)
- Remove `disabled={newMemberTemplate}` — one identical, fully-enabled secrets step for all template kinds.
- Per-secret block: name + manifest description; **three-way choice when a shared secret with that name exists**: ◉ Use project-level (default — this prevents token sprawl) / ○ Enter a value for this agent / ○ Skip — I'll add it later. Without a shared match: value input + a small `Skip` link. `Continue` is never gated; skipped secrets become required-missing rows after ship.
- Sandbox pre-checked per manifest, editable, captioned "Requested by template".
- Action: member installs keep writing directly (existing path, now also honoring the shared-attach choice → `secret_attachments` row). New-member installs write `pending_secrets` (sealed) + record shared-attach choices to apply at ship. Footer fine print: "Held values are discarded if the install is cancelled."
- Always write the lock `secrets` snapshot (§4.5) for every install kind.
- Pre-ship, the (future) agent's context shows pending rows: `⏳ NAME — Held for install · attaches when the member ships` (non-interactive except Discard pending value) — render wherever the drafted member is visible; if there is no such surface yet, this may be deferred to the ship-time migration + required-rows (they'd show as set immediately after ship).

### Deploy guard
At deploy initiation (deployments route UI, before calling the controller): compute missing = lock-required names for this agent − (set ∪ attached). If non-empty → blocking dialog "Missing required secrets": each missing row fixable **inline in the dialog** (value input [Set] or [Attach] when shared exists — same fetcher intents), `Deploy ✓` primary enabled only when resolved, `Deploy anyway` secondary always enabled (never hard-block), Cancel. Dismissed requirements don't trigger it. Keep the check UI-side (controller stays non-interactive); optionally also record a warning in deploy `errorDetail`-style metadata if deployed-anyway.

## 10. UX copy library + wireframes (canonical — implement verbatim)

| Context | Copy |
|---|---|
| Section note | `Values are encrypted write-only — they can be replaced but never viewed, even by you.` |
| Why popover | `Eden never exposes secret values after save, so a compromised browser session or screen-share can't leak them. To rotate a secret, replace its value.` |
| Fingerprint tooltip | `A one-way fingerprint of the value. Compare it against a value you hold to check they match. The value itself is never shown.` |
| Copy-name toast | `Name copied. Values can't be copied — Eden stores them write-only.` |
| Sandbox tooltip | `Adds this variable to the agent's terminal environment at deploy. Leave off for secrets only Eden's tools should use.` |
| Required badge | `Required — not set` |
| Replace confirm | `Replacing overwrites the stored value immediately. The old value can't be recovered.` |
| Shared replace confirm | `{n} agents use this secret. The new value applies to all of them on their next deploy.` |
| Deploy dialog title | `Missing required secrets` |
| Install deferral | `Values are held securely and attached when the member ships. Held values are discarded if the install is cancelled.` |
| Detach warning | `{agent}'s template requires {NAME}. Detaching will mark it missing.` |

Per-agent card:
```
┌─ Secrets · code-reviewer ────────────────────────────────────────────────┐
│ Env: (All) [Production] (Preview)      🔒 Write-only — values can        │
│                                        be replaced, never viewed. Why?  │
│ REQUIRED BY TEMPLATE ─────────────────────────────────────────────────   │
│ ⚠ CLOUDFLARE_API_TOKEN              required · cloudflare-app-builder    │
│   "API token with Workers deploy permission"                             │
│   Value [______________]  [✓] Sandbox (from template)         [Save]     │
│ THIS AGENT'S SECRETS ─────────────────────────────────────────────────   │
│ ✓ ANTHROPIC_API_KEY   ••••••••  Production                               │
│     Set just now · fp 7d02e1    [✓] Sandbox      [name⧉] [Replace] [🗑]  │
│ ✓ SLACK_WEBHOOK       ••••••••  All envs   (overrides shared) ⓘ          │
│     Set 8d ago · fp c19a44      [ ] Sandbox      [name⧉] [Replace] [🗑]  │
│ SHARED WITH PROJECT ──────────────────────────────────────────────────   │
│ ● GITHUB_TOKEN        ••••••••  All envs   Shared      [Attach ▣ on ]   │
│     Set 3d ago · fp 9c41b2      [✓] Sandbox (this agent)        [⋯]     │
│ ○ OPENROUTER_API_KEY  ········  Production Shared      [Attach ▢ off]   │
│     Project secret · not attached                                        │
│ ○ SLACK_WEBHOOK       ········  All envs   Shared · overridden above    │
│ ADD A SECRET ─────────────────────────────────────────────────────────   │
│ Name [____________] Value [________] Env [Production ▾] [✓] Sandbox      │
│                                                              [Add]       │
│ Dismissed requirements (0) ▾                                             │
└──────────────────────────────────────────────────────────────────────────┘
```
Shared Secrets (repo level):
```
┌─ Shared Secrets ─────────────────────────────────────────────────────┐
│ Define once, attach to any team member. 🔒 Values are write-only.    │
│  GITHUB_TOKEN            ••••••••  All envs                          │
│    Set 3d ago · fp 9c41b2 · Used by 3 agents ▾    [sandbox default]  │
│    └─ code-reviewer (sandbox ✓) · deployer · docs-bot                │
│                                                     [Replace] [🗑]    │
│  Name [____________] Value [________] Env [All ▾] [ ] Sandbox default│
│                                                              [Add]   │
└──────────────────────────────────────────────────────────────────────┘
```
Install step:
```
┌─ Install: cloudflare-app-builder ── Step: Secrets ───────────────┐
│ This agent needs 2 secrets. Enter them now — they'll be attached │
│ when the member ships. Values are encrypted write-only.          │
│  CLOUDFLARE_API_TOKEN — "API token with Workers deploy…"         │
│  Value [•••••••••••••]   [✓] Expose to sandbox shell   (Skip)    │
│  GITHUB_TOKEN — "Repo read/write for PR creation"                │
│  ◉ Use project-level GITHUB_TOKEN (recommended)                  │
│  ○ Enter a value for this agent  [____________]                  │
│  ○ Skip — I'll add it later                                      │
│                                  [Back]  [Skip all]  [Continue]  │
└──────────────────────────────────────────────────────────────────┘
```

## 11. Edge cases (must be handled + tested)

1. Agent secret shadows shared (same name): precedence per §5; UI badges; deleting override restores attachment behavior + toast.
2. Required name matches shared: offer Attach; never auto-attach.
3. Same name in multiple envs: legal; rows group by name with per-env lines each carrying own fingerprint/sandbox; add-form collision check is per-(name, env).
4. Delete shared with dependents: dialog lists agents + which go missing-required; on confirm, attachments cascade-delete.
5. Same name required by multiple agents with different manifest sandbox flags: fine — sandbox is per-attachment/per-agent; project page "Used by" shows per-agent flags.
6. Two installs on one member require the same name; one uninstalled: required-row persists while any lock entry references it; label `required · <tpl> +1`.
7. Fetcher races: row actions disable while any fetcher for that row is in flight.
8. Pending secrets orphaned (install abandoned / ship failed): cleanup on draft abandonment; consider a periodic sweep of `pending_secrets` older than N days.
9. `EDEN_SANDBOX_ENV` squatting via shared secrets: the controller's delete-before-set must run after the merged resolve (it already runs on the final env map — verify with a test that a *shared* secret named `EDEN_SANDBOX_ENV` is stripped).
10. Legacy rows without fingerprint: render gracefully (§4.1).

## 12. Suggested phasing (each phase lands green: `npm test` + typecheck + build)

1. **Schema + store:** migrations §4.1–4.5; nullable `agentId` type-chase; `listForResolve`/`listSandboxExposedNames` extensions + new helpers; fingerprint in provider `set`. Tests: `tests/unit/secrets.test.ts` + new store tests (precedence matrix of §5, attachment sandbox union, squatting via shared).
2. **Fetcher CRUD + row rework (gripes 1–3):** JSON-returning intents, new `SecretsSection` component tree (env pills, row anatomy, add form with sandbox, replace flow, optimistic/error rows). Tests: action-level unit tests for intents; existing `controller.test.ts` untouched semantics.
3. **Lock + required rows + deploy guard (gripe 4):** lock schema field, write on install, loader `missing` computation, required-row UI, dismissals, deploy dialog. Tests: `install.test.ts` (lock snapshot), new missing-computation tests.
4. **Install wizard (gripe 5):** enabled step, three-way choice, `pending_secrets` write + ship-time migration + abandonment cleanup. Tests: install action for both shapes; pending migration on ship.
5. **Shared secrets UI (gripe 6):** repo-level section, attach/detach toggles in agent card, dependents/ blast-radius dialogs.

Run the repo's verify flow after each UI phase (drive the settings page + an install end-to-end, not just unit tests). Note: the working tree currently has substantial uncommitted changes (playground/observability work) — coordinate/rebase before starting, and re-verify the cited line anchors.
