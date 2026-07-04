# Marketplace — the first-party catalog

This directory is the Recruit marketplace catalog (PRD §7.8): a curated set of **templates** —
pre-built tools, skills, subagents, and whole agents a customer instantiates instead of authoring
from scratch. A template is just **files + a manifest**; installing one materializes those files
into the customer's repo as a normal reviewable change-set. There is no build step — templates
are source.

**This directory's destiny is the eve OSS repo.** The owner decision (PRD §7.8, Distribution) is
that the v1 catalog lives inside `github.com/vercel/eve` as `marketplace/`, not a separate repo.
It's authored here in Eden and copied there. That's why `scripts/` imports **nothing** from
Eden's `app/` — the whole directory must validate and index itself standing alone.

(Inside Eden's repo it is named `catalog/` only because Vite's dev server would serve
`marketplace/index.json` over the app's `/marketplace` route on a hard reload; the copy into eve
renames it to `marketplace/`.)

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
    agents/<id>/
```

Note the plural: a template of `type: "tool"` lives under `templates/tools/`.

## Authoring a template

1. Create `templates/<type>s/<id>/` where `<id>` is a kebab-case slug that **equals the
   directory name**.
2. Write `template.json` (the manifest). The contract:

   | field | required | notes |
   |---|---|---|
   | `id` | yes | kebab-case slug, matches the directory name |
   | `type` | yes | `tool` \| `skill` \| `subagent` \| `agent` |
   | `name`, `description` | yes | non-empty |
   | `version` | yes | semver `x.y.z` |
   | `eve` | yes | semver *range* the template targets, e.g. `">=0.1.0"` |
   | `files` | yes | non-empty list of install-relative paths — **no absolute paths, no `..`, no backslashes** |
   | `dependencies` | no | npm name → version range; JSON-merged into the target's `package.json` |
   | `secrets` | no | `[{ name: UPPER_SNAKE, description? }]` — the install wizard makes placeholders |
   | `connections` | no | declared for future use |
   | `model` | no | suggested model (agent-type templates) |

3. Put the shipped files under `files/`, mirroring the install-relative paths — a tool at
   `files/tools/<id>.ts` installs to the target agent's `tools/<id>.ts`.
4. Run `npm run catalog:index` (regenerates `index.json`) then `npm run catalog:validate`.

The manifest format is also encoded as a Zod schema in Eden at `app/marketplace/manifest.ts`. The
two are deliberate duplicates — one contract, two homes (this directory ships to eve; Eden keeps
the schema its loaders parse against).

## How CI gates it

`scripts/validate.mjs` (run via `npm run catalog:validate`) fails the build unless:

- every `template.json` matches the format above;
- each template's `files` list matches its `files/` subtree **exactly**, both directions;
- every `id` is unique across the catalog and equals its directory name;
- `index.json` is present, lists every template exactly once, and every content hash matches a
  fresh recomputation (so a stale index — or a drifted file — is a hard failure).

The content hash is `sha1(hex)` over the canonicalized manifest plus every file's content in
sorted path order; `build-index.mjs` is the source of that rule.
