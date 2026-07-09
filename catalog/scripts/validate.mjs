#!/usr/bin/env node
/**
 * Catalog CI gate — validate every template in marketplace/ against the format, and prove
 * index.json is in sync (PRD §7.8: "validated + indexed by catalog CI, no build step").
 *
 * The format rules below deliberately DUPLICATE app/marketplace/manifest.ts (the Zod schema).
 * That's intentional: this directory is destined to live in the eve OSS repo as `marketplace/`
 * and must validate itself with zero dependency on Eden's app code (README.md). manifest.ts and
 * this script are two encodings of one contract — change one, change the other; the Eden unit
 * tests (tests/unit/marketplace.test.ts) cover the schema side.
 *
 * Beyond the per-manifest rules it checks the structural invariants a schema can't see:
 *   - each template's declared `files` list matches its files/ subtree exactly (both directions)
 *   - every id is unique and equals its directory name
 *   - index.json exists, lists every template exactly once, and every hash matches recomputation
 *   - composition (`includes`): every reference exists, there are no cycles, and the RESOLVED
 *     (flattened) file set of every template has no duplicate final paths — mirroring the Eden
 *     resolver's union rule (app/marketplace/compose.server.ts), so a violation fails BEFORE
 *     publish rather than at install time.
 *
 * Exit 1 with readable errors on any failure.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { buildIndex, loadTemplates } from "./build-index.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const TYPES = ["tool", "skill", "subagent", "channel", "connection", "bundle", "agent"];
/** Types a template may `includes`-reference — everything except `agent`. */
const INCLUDABLE = TYPES.filter((t) => t !== "agent");
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const UPPER_SNAKE = /^[A-Z][A-Z0-9_]*$/;

const errors = [];
const fail = (where, msg) => errors.push(`${where}: ${msg}`);

/** Mirror of manifest.ts's relative-path rule — no absolute paths, no `..`, no backslashes. */
function badPath(p) {
  if (typeof p !== "string" || p.length === 0)
    return "must be a non-empty string";
  if (p.startsWith("/")) return "must be relative (no leading slash)";
  if (p.includes("\\")) return "must use forward slashes";
  if (p.split("/").includes("..")) return "must not contain '..' segments";
  return null;
}

/** Mirror of manifest.ts's manifest rules. Pushes readable errors under `where`. */
function validateManifest(where, m) {
  if (!KEBAB.test(m.id ?? ""))
    fail(where, `id "${m.id}" is not a kebab-case slug`);
  if (!TYPES.includes(m.type))
    fail(where, `type "${m.type}" is not one of ${TYPES.join(", ")}`);
  if (!m.name) fail(where, "name is required");
  if (!m.description) fail(where, "description is required");
  if (!SEMVER.test(m.version ?? ""))
    fail(where, `version "${m.version}" is not semver x.y.z`);
  if (!m.eve) fail(where, "eve range is required");

  // Only a bundle may ship no files of its own (pure composition — its includes carry them).
  if (!Array.isArray(m.files) || (m.files.length === 0 && m.type !== "bundle")) {
    fail(where, "files must be a non-empty array (only a bundle may be empty)");
  } else {
    for (const p of m.files) {
      const reason = badPath(p);
      if (reason) fail(where, `file path "${p}" ${reason}`);
    }
  }
  // A file-less bundle with no includes would install nothing.
  if (
    m.type === "bundle" &&
    Array.isArray(m.files) &&
    m.files.length === 0 &&
    (m.includes?.length ?? 0) === 0
  ) {
    fail(where, "a bundle with no files must include at least one template");
  }

  if (m.dependencies !== undefined) {
    for (const [name, range] of Object.entries(m.dependencies)) {
      if (!name) fail(where, "dependency name must be non-empty");
      if (typeof range !== "string" || range.length === 0) {
        fail(where, `dependency "${name}" range must be a non-empty string`);
      }
    }
  }

  if (m.secrets !== undefined) {
    if (!Array.isArray(m.secrets)) fail(where, "secrets must be an array");
    else
      for (const s of m.secrets) {
        if (!UPPER_SNAKE.test(s?.name ?? "")) {
          fail(where, `secret name "${s?.name}" is not UPPER_SNAKE_CASE`);
        }
      }
  }

  if (m.connections !== undefined && !Array.isArray(m.connections)) {
    fail(where, "connections must be an array of strings");
  }
  if (m.sandbox !== undefined) {
    if (
      !m.sandbox ||
      typeof m.sandbox !== "object" ||
      Array.isArray(m.sandbox)
    ) {
      fail(where, "sandbox must be an object");
    } else {
      if (
        m.sandbox.bootstrap !== undefined &&
        (!Array.isArray(m.sandbox.bootstrap) ||
          m.sandbox.bootstrap.some(
            (cmd) => typeof cmd !== "string" || cmd.length === 0,
          ))
      ) {
        fail(where, "sandbox.bootstrap must be an array of non-empty strings");
      }
      if (
        m.sandbox.env !== undefined &&
        (!m.sandbox.env ||
          typeof m.sandbox.env !== "object" ||
          Array.isArray(m.sandbox.env) ||
          Object.entries(m.sandbox.env).some(
            ([name, value]) => !name || typeof value !== "string",
          ))
      ) {
        fail(where, "sandbox.env must be an object of string values");
      }
      if (
        m.sandbox.revalidationKey !== undefined &&
        (typeof m.sandbox.revalidationKey !== "string" ||
          m.sandbox.revalidationKey.length === 0)
      ) {
        fail(where, "sandbox.revalidationKey must be a non-empty string");
      }
    }
  }
  if (m.model !== undefined && typeof m.model !== "string") {
    fail(where, "model must be a string");
  }
  if (
    m.setup !== undefined &&
    (typeof m.setup !== "string" || m.setup.length === 0)
  ) {
    fail(where, "setup must be a non-empty string");
  }

  if (m.includes !== undefined) {
    if (!Array.isArray(m.includes)) {
      fail(where, "includes must be an array of { type, id }");
    } else {
      for (const inc of m.includes) {
        if (!inc || typeof inc !== "object" || Array.isArray(inc)) {
          fail(where, "each include must be an object { type, id }");
          continue;
        }
        if (!INCLUDABLE.includes(inc.type)) {
          fail(
            where,
            `include type "${inc.type}" is not one of ${INCLUDABLE.join(", ")}`,
          );
        }
        if (!KEBAB.test(inc.id ?? "")) {
          fail(where, `include id "${inc.id}" is not a kebab-case slug`);
        }
      }
    }
  }
}

/** Every file path (relative to `base`) under `base`, using forward slashes. */
function walkFiles(base) {
  const out = [];
  const recurse = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) recurse(abs);
      else out.push(relative(base, abs).split(sep).join("/"));
    }
  };
  try {
    if (statSync(base).isDirectory()) recurse(base);
  } catch {
    // no files/ dir — the empty set will mismatch a non-empty manifest below.
  }
  return out;
}

function main() {
  const templates = loadTemplates();
  const seenIds = new Map(); // id -> where (uniqueness across the whole catalog)

  for (const t of templates) {
    const where = `templates/${t.type}s/${t.id}`;
    validateManifest(where, t.manifest);

    // id must equal the directory name.
    if (t.manifest.id !== t.id) {
      fail(
        where,
        `manifest id "${t.manifest.id}" does not match directory name "${t.id}"`,
      );
    }
    // ids unique across the catalog.
    if (seenIds.has(t.manifest.id)) {
      fail(
        where,
        `duplicate id "${t.manifest.id}" (also in ${seenIds.get(t.manifest.id)})`,
      );
    } else {
      seenIds.set(t.manifest.id, where);
    }

    // files list must match files/ exactly, both directions.
    const declared = new Set(t.manifest.files ?? []);
    const onDisk = new Set(walkFiles(join(t.dir, "files")));
    for (const p of declared) {
      if (!onDisk.has(p))
        fail(where, `declares "${p}" but it is missing under files/`);
    }
    for (const p of onDisk) {
      if (!declared.has(p))
        fail(where, `ships "${p}" under files/ but it is not in the manifest`);
    }
  }

  // ── Composition: references exist, no cycles, and no duplicate RESOLVED file paths ──
  // Mirrors app/marketplace/compose.server.ts's union rule: a template's flattened file set is
  // every include's files (transitively, includes-first) plus its own; a path shipped twice — by
  // two artifacts or the same artifact reached via two include paths — is an error.
  const byKey = new Map(); // `${type}/${id}` -> template
  for (const t of templates) {
    byKey.set(`${t.manifest.type}/${t.manifest.id}`, t);
  }

  /** Resolve a template's flattened file owners, reporting cycles / missing refs / duplicates. */
  function checkResolvedFiles(startKey) {
    const owner = new Map(); // path -> owning `${type}/${id}`
    const visit = (key, stack) => {
      const where = `templates/${key.split("/")[0]}s/${key.split("/")[1]}`;
      if (stack.includes(key)) {
        fail(where, `include cycle: ${[...stack, key].join(" → ")}`);
        return false;
      }
      const t = byKey.get(key);
      if (!t) {
        // Reported against whoever referenced it (the previous stack frame), or itself if root.
        const from = stack.length > 0 ? stack[stack.length - 1] : key;
        fail(
          `templates/${from.split("/")[0]}s/${from.split("/")[1]}`,
          `includes "${key}", which is not a template in the catalog`,
        );
        return false;
      }
      const nextStack = [...stack, key];
      // Includes first (depth-first, in order), then this template's own files.
      for (const inc of t.manifest.includes ?? []) {
        if (!visit(`${inc.type}/${inc.id}`, nextStack)) return false;
      }
      for (const p of t.manifest.files ?? []) {
        if (owner.has(p)) {
          fail(
            where,
            `resolved file path "${p}" is shipped by both ${owner.get(p)} and ${key} — composed artifacts can't materialize the same file`,
          );
          return false;
        }
        owner.set(p, key);
      }
      return true;
    };
    visit(startKey, []);
  }

  for (const t of templates) {
    checkResolvedFiles(`${t.manifest.type}/${t.manifest.id}`);
  }

  // index.json must exist and match a fresh rebuild exactly (presence, one row each, hashes).
  let onDisk;
  try {
    onDisk = JSON.parse(readFileSync(join(ROOT, "index.json"), "utf8"));
  } catch {
    fail("index.json", "missing or unparseable — run `npm run catalog:index`");
  }
  if (onDisk) {
    const expected = buildIndex(templates);
    const expectedById = new Map(
      expected.templates.map((r) => [`${r.type}/${r.id}`, r]),
    );
    const listed = new Set();
    for (const row of onDisk.templates ?? []) {
      const key = `${row.type}/${row.id}`;
      if (listed.has(key)) fail("index.json", `lists ${key} more than once`);
      listed.add(key);
      const want = expectedById.get(key);
      if (!want)
        fail("index.json", `lists ${key}, which is not a template on disk`);
      else if (want.hash !== row.hash) {
        fail(
          "index.json",
          `hash for ${key} is stale — run \`npm run catalog:index\``,
        );
      }
    }
    for (const key of expectedById.keys()) {
      if (!listed.has(key))
        fail("index.json", `missing ${key} — run \`npm run catalog:index\``);
    }
  }

  if (errors.length > 0) {
    console.error(`Catalog validation failed (${errors.length} error(s)):`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(
    `Catalog OK — ${templates.length} template(s) valid and in sync.`,
  );
}

main();
