# Marketplace — the first-party catalog

This directory is the Recruit marketplace catalog (PRD §7.8): a curated set of **templates** — pre-built tools, skills, subagents, channels, connections, bundles, and whole agents a customer instantiates instead of authoring from scratch. A template is just **files + a manifest**; installing one materializes those files into the customer's repo as a normal reviewable change-set. There is no build step — templates are source.

A template can also **include** other templates by reference (see [Composition](#composition)): a channel like Discord is authored once and bundled into an agent, resolved to materialized files at install time.

**Authoring an agent?** Its `instructions.md` system prompt must follow [`CONSTITUTION.md`](./CONSTITUTION.md) — how we ground agents without over-specifying them. It's also the checklist for reviewing one.

**This directory's destiny is the eve OSS repo.** The owner decision (PRD §7.8, Distribution) is that the v1 catalog lives inside `github.com/vercel/eve` as `marketplace/`, not a separate repo. It's authored here in Eden and copied there. That's why `scripts/` imports **nothing** from Eden's `app/` — the whole directory must validate and index itself standing alone.

(Inside Eden's repo it is named `catalog/` only because Vite's dev server would serve `marketplace/index.json` over the app's `/marketplace` route on a hard reload; the copy into eve renames it to `marketplace/`.)

## Layout

```
marketplace/
  index.json                     # generated browse projection (do not hand-edit)
  scripts/
    build-index.mjs              # regenerate index.json (deterministic)
    validate.mjs                 # CI gate: format + structure + index sync
  templates/
    tools/<id>/                  # a Tool template
      template.json              # the manifest
      files/tools/<id>.ts        # the file(s) it ships (paths relative to the install root)
    skills/<id>/
    subagents/<id>/
    channels/<id>/
    connections/<id>/
    bundles/<id>/
    agents/<id>/
```

Note the plural: a template of `type: "tool"` lives under `templates/tools/`.

## Authoring a template

1. Create `templates/<type>s/<id>/` where `<id>` is a kebab-case slug that **equals the directory name**.
2. Write `template.json` (the manifest). The contract:

   | field                 | required | notes                                                                                                                |
   | --------------------- | -------- | -------------------------------------------------------------------------------------------------------------------- |
   | `id`                  | yes      | kebab-case slug, matches the directory name                                                                          |
   | `type`                | yes      | `tool` \| `skill` \| `subagent` \| `channel` \| `connection` \| `bundle` \| `agent`                                  |
   | `name`, `description` | yes      | non-empty                                                                                                            |
   | `version`             | yes      | semver `x.y.z`                                                                                                       |
   | `eve`                 | yes      | semver _range_ the template targets, e.g. `">=0.1.0"`                                                                |
   | `files`               | yes      | list of install-relative paths — **no absolute paths, no `..`, no backslashes**; non-empty for every type except `bundle` (a bundle may be pure composition) |
   | `dependencies`        | no       | npm name → version range; JSON-merged into the target's `package.json`                                               |
   | `secrets`             | no       | `[{ name: UPPER_SNAKE, description?, provisioned?, generated? }]` — the install wizard makes placeholders; `provisioned` (a guided Eden flow sets it) and `generated` (Eden mints it — see [Connection providers](#connection-providers)) are never prompted and mutually exclusive |
   | `sandbox`             | no       | sandbox setup merged into the target agent, e.g. `bootstrap` shell commands, `env` defaults, and a `revalidationKey` |
   | `auth`                | no       | `{ provider, kind: "oauth2", scopes?, scopeGroups? }` — brokered OAuth descriptor, `connection` templates only; at least one of `scopes` (always-requested baseline) / `scopeGroups` (user-selectable permission levels) required (see [Connection providers](#connection-providers)) |
   | `connections`         | no       | declared for future use                                                                                              |
   | `model`               | no       | suggested model (agent-type templates)                                                                               |
   | `setup`               | no       | Markdown, shown on the detail page before install — provider-side steps a secret description can't hold (create an app, point a webhook at the agent's endpoint, grant scopes). Mainly channels |
   | `includes`            | no       | `[{ type, id }]` — other catalog templates bundled by reference; `type` is any type except `agent` (see Composition) |

3. Put the shipped files under `files/`, mirroring the install-relative paths — a tool at `files/tools/<id>.ts` installs to the target agent's `tools/<id>.ts`.
4. Run `npm run catalog:index` (regenerates `index.json`) then `npm run catalog:validate`.

The manifest format is also encoded as a Zod schema in Eden at `app/marketplace/manifest.ts`. The two are deliberate duplicates — one contract, two homes (this directory ships to eve; Eden keeps the schema its loaders parse against).

## How CI gates it

`scripts/validate.mjs` (run via `npm run catalog:validate`) fails the build unless:

- every `template.json` matches the format above;
- each template's `files` list matches its `files/` subtree **exactly**, both directions;
- every `id` is unique across the catalog and equals its directory name;
- `index.json` is present, lists every template exactly once, and every content hash matches a fresh recomputation (so a stale index — or a drifted file — is a hard failure);
- every `includes` reference resolves to a template in the catalog, there are no include cycles, and no template's **resolved** (flattened) file set has a duplicate final path.

The content hash is `sha1(hex)` over the canonicalized manifest plus every file's content in sorted path order; `build-index.mjs` is the source of that rule. A template's own hash does **not** depend on what it `includes` — includes are flattened at install time, not folded into the hash.

## Composition

A template may bundle other templates by reference with `includes: [{ type, id }]`. `type` is any template type except `agent` (an agent is a whole team member — it installs as its own root and can't flatten into a parent). Includes may nest (a skill may include a tool); cycles are an error.

The `bundle` type is composition made first-class (issue #42): a named group of includable assets that installs **into an existing member** as one unit, with no (or few) files of its own. An `agent` is conceptually a bundle that also seeds a new member. Installing a composite onto a member that already has one of its includes installed standalone *absorbs* that install — the composite takes ownership of its files and lock entry instead of refusing on a path conflict.

At install (and update) time Eden's resolver flattens each reference into the parent, so:

- **installed repos get materialized files** — never a live reference. The included channel/tool lands as ordinary files under the target agent's root.
- **the same catalog snapshot** the parent came from resolves its includes — there is no per-include version pin. The **parent's own version bump** is what delivers newer included artifacts to an existing install (update detection compares the parent's version, unchanged).
- **the parent wins collisions**: on a duplicated dependency range or sandbox `env` key the parent's value wins; secrets union by name (first occurrence keeps its description, `sandbox` flags OR); `model` and the `eve` range are the parent's only.
- **file-path collisions and cycles are CI failures** (above), caught before publish.

## Connection providers

A `connection` template with an `auth` block rides Eden's auth-brokered OAuth flow (issues
#30, #163): the Deployment tab's Connections card shows a Connect button (connecting is a
deployment concern — the install wizard collects no credentials), Eden runs the consent flow
against its operator-registered OAuth app, stores the grant, and injects the credentials at
deploy. The contract:

- **`auth.provider` must name a registered provider.** The registry lives in Eden at
  `app/connections/providers.server.ts` — one object per provider carrying its endpoints,
  PKCE flag, authorize params, and env prefix. A template naming an unregistered provider
  renders on the Deployment tab as "not supported by this Eden installation"; supporting a
  new provider is a registry addition in Eden, not a template concern.
- **The template's `setup` text carries the operator instructions** (following the
  google-sheets template's pattern): create the OAuth app with the provider, set
  `EDEN_<PREFIX>_CLIENT_ID` / `EDEN_<PREFIX>_CLIENT_SECRET` on the Eden control plane, and
  register the redirect URI `<origin>/connections/<provider>/callback` (Google alone keeps
  the legacy `<origin>/google/callback`).
- **At deploy Eden injects `<PREFIX>_OAUTH_CLIENT_ID` / `<PREFIX>_OAUTH_CLIENT_SECRET` /
  `<PREFIX>_OAUTH_REFRESH_TOKEN`** for every provider the agent holds an active grant for;
  the shipped connection file refreshes its own access tokens from those at runtime. It also
  injects **`<PREFIX>_OAUTH_SCOPES`** — the scopes the account actually *granted*,
  space-joined — so agent code can read its own permission level (don't offer to send mail
  when only read was granted; the gmail template's connection file shows the pattern).

### Permission levels: `scopes` vs `scopeGroups`

The `auth` block requests permissions two ways (issue #165), and the rule is **one template
per system — permission levels are a user choice, never template variants**. Never publish
"`foo` read-only" and "`foo` full" as two catalog entries: the wrong pick caps the install
forever, and every level doubles the catalog.

- **`scopes`** — the always-requested baseline. Use it alone when the connector is
  single-purpose and there is exactly one sensible permission set (google-sheets: one
  `spreadsheets` scope). This is also the back-compat shape: templates with only `scopes`
  behave exactly as before scope groups existed.
- **`scopeGroups`** — named, user-selectable levels
  (`{ id, label, description, scopes, default? }`). Use it whenever the system has separable
  capabilities a cautious installer would want to withhold (gmail: *Read mail* / *Manage
  labels* / *Send mail*). The installer ticks groups in the install wizard (`default: true`
  groups pre-ticked), the OAuth consent requests baseline ∪ selected groups, and the
  selection stays editable on the agent's Deployment tab — widening asks for one reconnect,
  narrowing takes effect on reconnect. Overlapping groups are fine (gmail's `gmail.modify` ⊃
  `gmail.readonly`): the union is what's requested, so keep each group's meaning simple
  rather than carving disjoint scope sets. Group ids are **provider-level identities**: when
  two composed templates (a bundle's includes) declare the same group id for the same
  provider, they define ONE level — the checkbox keeps the first occurrence's
  label/description, the scopes union, and `default` pre-ticks if either side says so. Reuse
  an id (`read`, `send`) only when the levels genuinely coincide; otherwise pick distinct ids.

At least one of the two must be present; declaring both means "always this baseline, plus
whatever levels the installer picks". Write group `description`s as plain-words capability
statements ("send messages as the connected account") — they render as checkbox help text in
the install wizard and the Deployment tab's Permissions editor.

Two adjacent capabilities connection/channel templates can rely on:

- **Generated secrets** — a secrets entry with `generated: true` is a value nobody types
  (e.g. a random state-encryption key). It is never prompted in the install wizard; Eden
  mints a random value once per agent + environment at first deploy and keeps it stable
  across redeploys (mutually exclusive with `provisioned`).
- **`EVE_PUBLIC_ORIGIN`** — when the operator configures `EDEN_PUBLIC_ORIGIN`, every deployed
  instance receives `EVE_PUBLIC_ORIGIN`, its per-environment public ingress URL, so adapters
  that take inbound webhooks can build callback URLs. Treat it as optional at runtime — it is
  unset in local dev and on installations without a public origin.
