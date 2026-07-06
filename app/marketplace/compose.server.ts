/**
 * Catalog-level COMPOSITION — the include resolver (PRD §7.8, marketplace composition).
 *
 * A channel like Discord is defined ONCE as its own marketplace artifact; agent (and other)
 * templates bundle it by reference via the manifest's `includes`. This module sits ON TOP of the
 * unchanged CatalogSource seam: it depth-first resolves those references and FLATTENS them into a
 * single materialized template, so an installed repo contains ordinary files under the target's
 * root — never a live reference. The planner (install.server.ts) then treats the resolved template
 * exactly like a hand-written one.
 *
 * Update semantics fall out of this design unchanged: includes resolve from the SAME catalog
 * snapshot the parent came from (no per-include version pinning), and the parent template's own
 * version bump is the update gate — an install receives newer included files only when the parent
 * publishes a new version and the user updates it.
 *
 * The flatten rules are deliberately asymmetric and encoded once here (mirrored by the catalog CI
 * in validate.mjs so the same violations fail before publish):
 *  - files      union of every include + the parent; a path shipped by two artifacts is an ERROR
 *               (materialization can't write one path twice).
 *  - deps       merged includes-first then the parent on top; a name collision — the LATER (more
 *               parental) range wins silently.
 *  - secrets    union by name (includes-first then parent); first occurrence keeps its
 *               description; sandbox flags OR together.
 *  - connections union, deduped, includes-first then parent.
 *  - sandbox    one merged setup: bootstrap concatenated includes-first then parent-last; env
 *               merged with the parent winning collisions; revalidationKey = the non-empty keys
 *               joined with "|" (includes-first, parent-last).
 *  - model/eve  the parent's only — an include never dictates the host agent's model or eve range.
 *
 * The resolved `hash` is the PARENT's OWN content hash (own manifest + own files) so it still
 * matches the parent's `index.json` row; each ResolvedInclude.hash is likewise that include's own
 * content hash. Both use the shared hash rule (hash.server.ts) — never a fork.
 */
import type { TemplateManifest, TemplateType } from "./manifest";
import { templateContentHash } from "./hash.server";
import type { CatalogSource, CatalogTemplate } from "~/seams/types";

/** One resolved include reference — provenance recorded in the lock alongside the flattened files. */
export interface ResolvedInclude {
  id: string;
  type: TemplateType;
  name: string;
  /** The include's own version (from its manifest) at resolution time. */
  version: string;
  /** The include's OWN content hash — matches its `index.json` row, not the flattened form. */
  hash: string;
}

/** A template with every include flattened into it — what the planner installs. */
export interface ResolvedTemplate {
  /** Parent manifest with flattened files/deps/secrets/connections/sandbox; `includes` removed. */
  manifest: TemplateManifest;
  /** install-relative path → content: the union of every include's files plus the parent's. */
  files: Record<string, string>;
  /** The PARENT's own content hash — matches its index row (includes never change it). */
  hash: string;
  /** Direct include references, each with its own name/version/hash (composition provenance). */
  includes: ResolvedInclude[];
}

/** Depth cap on include nesting — a defensive bound; real catalogs nest one or two deep. */
const MAX_DEPTH = 8;

type SandboxSetup = NonNullable<TemplateManifest["sandbox"]>;

/** A readable artifact label for collision errors, e.g. "channel/discord". */
function label(manifest: TemplateManifest): string {
  return `${manifest.type}/${manifest.id}`;
}

/**
 * Resolve a template and every template it includes into one flattened `ResolvedTemplate`.
 * Depth-first in manifest `includes` order; recursion allowed. Throws on a cycle (naming it), on
 * exceeding the depth cap, on including an `agent`, or on two artifacts shipping the same path.
 */
export async function resolveTemplate(
  source: CatalogSource,
  type: TemplateType,
  id: string,
): Promise<ResolvedTemplate> {
  return resolve(source, type, id, []);
}

async function resolve(
  source: CatalogSource,
  type: TemplateType,
  id: string,
  stack: string[],
): Promise<ResolvedTemplate> {
  const node = `${type}/${id}`;
  if (stack.includes(node)) {
    throw new Error(
      `Include cycle detected: ${[...stack, node].join(" → ")}.`,
    );
  }
  if (stack.length >= MAX_DEPTH) {
    throw new Error(
      `Include nesting exceeds the depth cap of ${MAX_DEPTH}: ${[...stack, node].join(" → ")}.`,
    );
  }

  const template = await source.template(type, id);
  const manifest = template.manifest;
  // The parent's OWN content hash (own manifest + own files) — matches its index row. Computed
  // BEFORE flattening: includes never affect a template's hash.
  const ownHash = templateContentHash(template);

  const nextStack = [...stack, node];
  const resolvedIncludes: ResolvedTemplate[] = [];
  const provenance: ResolvedInclude[] = [];

  for (const inc of manifest.includes ?? []) {
    // Cheap guard (schema already rejects an `agent` include, but defend the resolver too).
    if ((inc.type as TemplateType) === "agent") {
      throw new Error(
        `Template ${node} includes an agent (${inc.id}) — agents install as their own team member and can't be bundled by reference.`,
      );
    }
    const child = await resolve(source, inc.type, inc.id, nextStack);
    // The GitHub source parses remote bytes, so a mislabeled reference could resolve to an
    // agent-typed manifest — reject that too.
    if (child.manifest.type === "agent") {
      throw new Error(
        `Template ${node} includes ${label(child.manifest)}, which is an agent — agents can't be bundled by reference.`,
      );
    }
    resolvedIncludes.push(child);
    provenance.push({
      id: child.manifest.id,
      type: child.manifest.type,
      name: child.manifest.name,
      version: child.manifest.version,
      hash: child.hash,
    });
  }

  // ── files: union of every include (in order) then the parent; duplicates are an error ──
  const files: Record<string, string> = {};
  const fileList: string[] = [];
  const owner = new Map<string, string>();
  const addFiles = (src: ResolvedTemplate | CatalogTemplate) => {
    const from = label(src.manifest);
    for (const path of src.manifest.files) {
      if (owner.has(path)) {
        throw new Error(
          `Duplicate file path "${path}" — shipped by both ${owner.get(path)} and ${from}. Two composed artifacts can't materialize the same file.`,
        );
      }
      owner.set(path, from);
      files[path] = src.files[path];
      fileList.push(path);
    }
  };
  for (const child of resolvedIncludes) addFiles(child);
  addFiles(template);

  // ── dependencies: includes-first then parent on top (later, more-parental range wins) ──
  const deps: Record<string, string> = {};
  for (const child of resolvedIncludes) {
    Object.assign(deps, child.manifest.dependencies ?? {});
  }
  Object.assign(deps, manifest.dependencies ?? {});

  // ── secrets: union by name (includes-first then parent); first occurrence keeps its
  // description; sandbox flags OR together ──
  const secretByName = new Map<
    string,
    { name: string; description?: string; sandbox?: boolean }
  >();
  const addSecrets = (list: TemplateManifest["secrets"]) => {
    for (const s of list ?? []) {
      const existing = secretByName.get(s.name);
      if (!existing) {
        secretByName.set(s.name, {
          name: s.name,
          ...(s.description !== undefined ? { description: s.description } : {}),
          ...(s.sandbox ? { sandbox: true } : {}),
        });
      } else {
        // First occurrence wins the description; sandbox ORs across all occurrences.
        if (s.sandbox) existing.sandbox = true;
      }
    }
  };
  for (const child of resolvedIncludes) addSecrets(child.manifest.secrets);
  addSecrets(manifest.secrets);
  const secrets = [...secretByName.values()];

  // ── connections: union, deduped, includes-first then parent ──
  const connectionSet = new Set<string>();
  for (const child of resolvedIncludes) {
    for (const c of child.manifest.connections ?? []) connectionSet.add(c);
  }
  for (const c of manifest.connections ?? []) connectionSet.add(c);
  const connections = [...connectionSet];

  // ── sandbox: one merged setup, includes-first then parent-last (parent wins env collisions) ──
  const sandbox = mergeSandbox(
    resolvedIncludes.map((c) => c.manifest.sandbox),
    manifest.sandbox,
  );

  // The resolved manifest is the parent's, with flattened fields substituted and `includes`
  // stripped so the lock's dependency/secret snapshots are exactly the flattened truth.
  const resolvedManifest: TemplateManifest = { ...manifest };
  delete resolvedManifest.includes;
  resolvedManifest.files = fileList;
  setOrDelete(resolvedManifest, "dependencies", deps, Object.keys(deps).length > 0);
  setOrDelete(resolvedManifest, "secrets", secrets, secrets.length > 0);
  setOrDelete(resolvedManifest, "connections", connections, connections.length > 0);
  setOrDelete(resolvedManifest, "sandbox", sandbox, sandbox !== undefined);

  return {
    manifest: resolvedManifest,
    files,
    hash: ownHash,
    includes: provenance,
  };
}

/** Assign `value` to `manifest[key]` when `keep`, else remove the key entirely (no empty fields). */
function setOrDelete<K extends keyof TemplateManifest>(
  manifest: TemplateManifest,
  key: K,
  value: TemplateManifest[K],
  keep: boolean,
): void {
  if (keep) manifest[key] = value;
  else delete manifest[key];
}

/**
 * Merge include sandbox setups (in order) with the parent's on top into one setup, or undefined
 * when nothing contributes: bootstrap concatenated includes-first then parent-last; env merged
 * with the parent winning; revalidationKey = the non-empty keys joined with "|".
 */
function mergeSandbox(
  includeSetups: Array<SandboxSetup | undefined>,
  parentSetup: SandboxSetup | undefined,
): SandboxSetup | undefined {
  const ordered = [...includeSetups, parentSetup].filter(
    (s): s is SandboxSetup => s !== undefined,
  );
  if (ordered.length === 0) return undefined;

  const bootstrap: string[] = [];
  const env: Record<string, string> = {};
  const keys: string[] = [];
  for (const setup of ordered) {
    for (const cmd of setup.bootstrap ?? []) bootstrap.push(cmd);
    Object.assign(env, setup.env ?? {}); // parent is last → wins collisions
    if (setup.revalidationKey) keys.push(setup.revalidationKey);
  }

  const merged: SandboxSetup = {};
  if (bootstrap.length > 0) merged.bootstrap = bootstrap;
  if (Object.keys(env).length > 0) merged.env = env;
  if (keys.length > 0) merged.revalidationKey = keys.join("|");
  // Every branch above was empty → the ordered setups were all `{}`; still nothing to emit.
  if (
    !merged.bootstrap &&
    !merged.env &&
    !merged.revalidationKey
  ) {
    return undefined;
  }
  return merged;
}
