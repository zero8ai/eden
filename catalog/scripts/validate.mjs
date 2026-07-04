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
 *
 * Exit 1 with readable errors on any failure.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { buildIndex, loadTemplates } from "./build-index.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const TYPES = ["tool", "skill", "subagent", "agent"];
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const UPPER_SNAKE = /^[A-Z][A-Z0-9_]*$/;

const errors = [];
const fail = (where, msg) => errors.push(`${where}: ${msg}`);

/** Mirror of manifest.ts's relative-path rule — no absolute paths, no `..`, no backslashes. */
function badPath(p) {
  if (typeof p !== "string" || p.length === 0) return "must be a non-empty string";
  if (p.startsWith("/")) return "must be relative (no leading slash)";
  if (p.includes("\\")) return "must use forward slashes";
  if (p.split("/").includes("..")) return "must not contain '..' segments";
  return null;
}

/** Mirror of manifest.ts's manifest rules. Pushes readable errors under `where`. */
function validateManifest(where, m) {
  if (!KEBAB.test(m.id ?? "")) fail(where, `id "${m.id}" is not a kebab-case slug`);
  if (!TYPES.includes(m.type)) fail(where, `type "${m.type}" is not one of ${TYPES.join(", ")}`);
  if (!m.name) fail(where, "name is required");
  if (!m.description) fail(where, "description is required");
  if (!SEMVER.test(m.version ?? "")) fail(where, `version "${m.version}" is not semver x.y.z`);
  if (!m.eve) fail(where, "eve range is required");

  if (!Array.isArray(m.files) || m.files.length === 0) {
    fail(where, "files must be a non-empty array");
  } else {
    for (const p of m.files) {
      const reason = badPath(p);
      if (reason) fail(where, `file path "${p}" ${reason}`);
    }
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
  if (m.model !== undefined && typeof m.model !== "string") {
    fail(where, "model must be a string");
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
      fail(where, `manifest id "${t.manifest.id}" does not match directory name "${t.id}"`);
    }
    // ids unique across the catalog.
    if (seenIds.has(t.manifest.id)) {
      fail(where, `duplicate id "${t.manifest.id}" (also in ${seenIds.get(t.manifest.id)})`);
    } else {
      seenIds.set(t.manifest.id, where);
    }

    // files list must match files/ exactly, both directions.
    const declared = new Set(t.manifest.files ?? []);
    const onDisk = new Set(walkFiles(join(t.dir, "files")));
    for (const p of declared) {
      if (!onDisk.has(p)) fail(where, `declares "${p}" but it is missing under files/`);
    }
    for (const p of onDisk) {
      if (!declared.has(p)) fail(where, `ships "${p}" under files/ but it is not in the manifest`);
    }
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
    const expectedById = new Map(expected.templates.map((r) => [`${r.type}/${r.id}`, r]));
    const listed = new Set();
    for (const row of onDisk.templates ?? []) {
      const key = `${row.type}/${row.id}`;
      if (listed.has(key)) fail("index.json", `lists ${key} more than once`);
      listed.add(key);
      const want = expectedById.get(key);
      if (!want) fail("index.json", `lists ${key}, which is not a template on disk`);
      else if (want.hash !== row.hash) {
        fail("index.json", `hash for ${key} is stale — run \`npm run catalog:index\``);
      }
    }
    for (const key of expectedById.keys()) {
      if (!listed.has(key)) fail("index.json", `missing ${key} — run \`npm run catalog:index\``);
    }
  }

  if (errors.length > 0) {
    console.error(`Catalog validation failed (${errors.length} error(s)):`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(`Catalog OK — ${templates.length} template(s) valid and in sync.`);
}

main();
