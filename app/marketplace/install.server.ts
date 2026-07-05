/**
 * The install PLANNER — pure functions that turn "install this template here" into a concrete
 * change-set (writes, deletions, conflicts, warnings), with zero I/O (PRD §7.8 "Install = a
 * change-set").
 *
 * The split is deliberate: the wizard route gathers the inputs (repo tree, staged drafts, the
 * target's package.json, the current lock — GitHub/DB reads) and hands this module PLAIN DATA;
 * this module decides. That keeps every branch — path mapping, the dependency merge conflict
 * policy, update-vs-conflict, the lock upsert — unit-testable against literals, and keeps the
 * route a thin "gather → plan → stage" shell that re-plans server-side before it writes.
 *
 * Two paths mirror the two install shapes:
 *  - a tool/skill/subagent installs INTO an existing member (files land under that member's
 *    agent root; deps merge into that member's package.json);
 *  - an agent installs AS A NEW team member (a fresh `agents/<name>/` project — files plus a
 *    generated package.json).
 * Both always rewrite `eden-lock.json` so provenance is one more reviewable file in the PR.
 */
import { createHash } from "node:crypto";

import semver from "semver";

import { ZOD_PACKAGE, ZOD_VERSION } from "~/eve/agentModule";
import type { CatalogTemplate } from "~/seams/types";
import { isTemplateSlug } from "./manifest";
import {
  findInstall,
  removeInstall,
  serializeLock,
  upsertInstall,
  type EdenLock,
  type InstallEntry,
} from "./lock";

/** Files that are MERGED, never owned — they can't be conflicts and never land in a lock entry. */
const MERGED_FILES = new Set(["eden-lock.json"]);

/** Where an install lands. */
export type InstallTarget =
  /** Into an existing agent: tool/skill/subagent. `memberName` null = single-agent root. */
  | { kind: "member"; memberName: string | null; root: string }
  /** As a new team member: agent template → a fresh `agents/<name>/` project. */
  | { kind: "new-member"; name: string };

export interface PlanContext {
  template: CatalogTemplate;
  /** Locator string recorded in the lock — "fixture" or "github:owner/repo@ref". */
  registry: string;
  /** Every repo-relative path currently on the default branch (conflict detection). */
  repoPaths: string[];
  /** Staged drafts overlaid on the repo (a non-deletion draft occupies a path like a real file). */
  drafts: Array<{ path: string; content: string | null }>;
  /** CURRENT contents of the target's package.json (caller overlays drafts); null if absent. */
  packageJson: string | null;
  /** Current lock (caller overlays a staged eden-lock.json draft); empty default. */
  lock: EdenLock;
  target: InstallTarget;
  /** Existing roster member names — a new-member install must not collide with one. */
  rosterNames?: string[];
}

export interface InstallPlan {
  /** Files to create/overwrite — the template's files, the merged package.json, the lock. */
  writes: Array<{ path: string; content: string }>;
  /** Update mode: files the OLD version had that the new one drops (staged as deletions). */
  deletions: string[];
  /** BLOCKING: a target path already exists and isn't ours (or an invalid new-member name). */
  conflicts: string[];
  /** Non-blocking: e.g. a dependency range disagreement the reviewer should eyeball. */
  warnings: string[];
  /** True when this (id, member) was already installed — an overwrite, not a first install. */
  isUpdate: boolean;
  /** Secrets the manifest asks for, for the wizard to collect (values never touch the plan). */
  secrets: Array<{ name: string; description?: string }>;
}

/** The lock's registry locator, from the same env the CatalogSource seam reads (index.server). */
export function catalogLocator(): string {
  const repo = process.env.EDEN_CATALOG_REPO;
  if (!repo) return "fixture";
  const ref = process.env.EDEN_CATALOG_REF ?? "main";
  return `github:${repo}@${ref}`;
}

/** The npm project dir for a member is the PARENT of its agent root, so package.json sits there. */
export function packageJsonPathForRoot(root: string): string {
  const slash = root.lastIndexOf("/");
  const parent = slash === -1 ? "" : root.slice(0, slash);
  return parent ? `${parent}/package.json` : "package.json";
}

/**
 * Content hash of a fully-loaded template — sha1(hex) over the canonical manifest plus every
 * file in sorted path order (`path\0content`). Kept in lockstep with the catalog's
 * build-index.mjs / validate.mjs and tests/unit/marketplace.test.ts; recorded in the lock so
 * provenance matches the index row it came from.
 */
function templateContentHash(template: CatalogTemplate): string {
  const parts = [stableStringify(template.manifest)];
  for (const path of Object.keys(template.files).sort()) {
    parts.push(`${path}\0${template.files[path]}`);
  }
  return createHash("sha1").update(parts.join("\n")).digest("hex");
}

/** Deterministic JSON (object keys sorted recursively) — the hash's canonical form. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${stableStringify(
            (value as Record<string, unknown>)[k],
          )}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Do two npm ranges share any version? Unparseable ranges are treated as disjoint (→ warn). */
function rangesIntersect(a: string, b: string): boolean {
  try {
    return semver.intersects(a, b);
  } catch {
    return false;
  }
}

/**
 * Merge template dependencies into a package's deps by the PRD's policy: absent → add; present
 * and the ranges intersect → keep the agent's silently (no diff churn); present and disjoint
 * (or unparseable) → keep the agent's and warn. Keys come back alphabetized.
 */
function mergeDependencies(
  current: Record<string, string>,
  wanted: Record<string, string>,
): { deps: Record<string, string>; warnings: string[] } {
  const deps: Record<string, string> = { ...current };
  const warnings: string[] = [];
  for (const [name, wantRange] of Object.entries(wanted)) {
    const existing = deps[name];
    if (existing === undefined) {
      deps[name] = wantRange;
      continue;
    }
    if (rangesIntersect(existing, wantRange)) continue;
    warnings.push(
      `\`${name}\`: agent pins \`${existing}\`, template wants \`${wantRange}\` — kept the agent's; review before merging.`,
    );
  }
  const sorted = Object.fromEntries(
    Object.keys(deps)
      .sort()
      .map((k) => [k, deps[k]]),
  );
  return { deps: sorted, warnings };
}

/** Serialize a package.json object the repo's way: 2-space indent, trailing newline. */
function serializePackageJson(obj: Record<string, unknown>): string {
  return JSON.stringify(obj, null, 2) + "\n";
}

/** The generated package.json for a brand-new team member (mirrors memberScaffold's shape). */
function newMemberPackageJson(
  name: string,
  templateDeps: Record<string, string>,
): { content: string; warnings: string[] } {
  const { deps, warnings } = mergeDependencies(
    { eve: "latest", [ZOD_PACKAGE]: ZOD_VERSION },
    templateDeps,
  );
  return {
    content: serializePackageJson({
      name,
      private: true,
      type: "module",
      scripts: { dev: "eve dev", build: "eve build" },
      dependencies: deps,
    }),
    warnings,
  };
}

/** One dependency's fate in the merge, for the wizard's add/keep/conflict badges. */
export interface DependencyDecision {
  name: string;
  /** The range the template wants. */
  range: string;
  status: "add" | "keep" | "conflict";
}

/**
 * Describe how each template dependency would merge against the target's current deps — the
 * display projection behind the wizard's badges. Mirrors `mergeDependencies`' policy exactly.
 */
export function describeDependencies(
  current: Record<string, string> | null,
  wanted: Record<string, string> | undefined,
): DependencyDecision[] {
  const cur = current ?? {};
  return Object.entries(wanted ?? {}).map(([name, range]) => {
    const existing = cur[name];
    if (existing === undefined) return { name, range, status: "add" as const };
    return {
      name,
      range,
      status: rangesIntersect(existing, range) ? ("keep" as const) : ("conflict" as const),
    };
  });
}

export function planInstall(ctx: PlanContext): InstallPlan {
  const { template, target } = ctx;
  const manifest = template.manifest;
  const rosterNames = ctx.rosterNames ?? [];
  const conflicts: string[] = [];
  const warnings: string[] = [];
  const writes: Array<{ path: string; content: string }> = [];

  // ── 1. Map the template files to their final repo paths, and who owns the install ──
  let member: string | null;
  let fileWrites: Array<{ path: string; content: string }>;

  if (target.kind === "new-member") {
    member = target.name;
    if (!isTemplateSlug(target.name)) {
      conflicts.push(
        `"${target.name}" isn't a valid member name — use lowercase letters, digits, and single hyphens.`,
      );
    } else if (rosterNames.includes(target.name)) {
      conflicts.push(
        `A member named "${target.name}" already exists — pick another name, or install into it instead.`,
      );
    }
    const dir = `agents/${target.name}/agent`;
    fileWrites = manifest.files.map((f) => ({
      path: `${dir}/${f}`,
      content: template.files[f],
    }));
    const pkg = newMemberPackageJson(target.name, manifest.dependencies ?? {});
    writes.push(...fileWrites, {
      path: `agents/${target.name}/package.json`,
      content: pkg.content,
    });
    warnings.push(...pkg.warnings);
  } else {
    member = target.memberName;
    fileWrites = manifest.files.map((f) => ({
      path: `${target.root}/${f}`,
      content: template.files[f],
    }));
    writes.push(...fileWrites);
    // Dependency merge into the member's package.json (only when the template asks for any).
    if (manifest.dependencies && Object.keys(manifest.dependencies).length > 0) {
      const pkgPath = packageJsonPathForRoot(target.root);
      // A package.json we can't parse can't be merged — that's a blocking conflict for the
      // human to fix, not a crash for the wizard to 500 on.
      let base: Record<string, unknown> | null = {};
      if (ctx.packageJson) {
        try {
          base = JSON.parse(ctx.packageJson) as Record<string, unknown>;
        } catch {
          base = null;
          conflicts.push(`${pkgPath} is not valid JSON — fix it before installing.`);
        }
      }
      if (base) {
        const currentDeps = (base.dependencies as Record<string, string>) ?? {};
        const { deps, warnings: depWarnings } = mergeDependencies(
          currentDeps,
          manifest.dependencies,
        );
        warnings.push(...depWarnings);
        const merged = serializePackageJson({ ...base, dependencies: deps });
        // Only stage package.json when it actually changed — no churn when every dep intersects.
        if (merged !== ctx.packageJson) {
          writes.push({ path: pkgPath, content: merged });
        }
      }
    }
  }

  // ── 2. Conflicts & update detection ──
  // An existing lock entry for this (id, member) makes overwriting our own files legal — an
  // UPDATE — and turns files the old version had but the new one lacks into deletions.
  const existing =
    target.kind === "member"
      ? findInstall(ctx.lock, manifest.id, member)
      : undefined;
  const isUpdate = !!existing;
  const owned = new Set(existing?.files ?? []);
  const newPaths = new Set(fileWrites.map((w) => w.path));

  const draftAt = new Map(ctx.drafts.map((d) => [d.path, d.content]));
  // A new member's generated package.json is a CREATE (not a merge like an existing member's),
  // so an orphan file already at that path — a half-deleted member — must block, not be clobbered.
  const createPaths = fileWrites.map((w) => w.path);
  if (target.kind === "new-member") {
    createPaths.push(`agents/${target.name}/package.json`);
  }
  for (const path of createPaths) {
    if (owned.has(path)) continue; // ours already — overwrite is fine (update)
    const occupiedInRepo = ctx.repoPaths.includes(path);
    const occupiedByDraft = draftAt.has(path) && draftAt.get(path) !== null;
    if (occupiedInRepo || occupiedByDraft) conflicts.push(path);
  }

  const deletions = existing
    ? existing.files.filter((f) => !newPaths.has(f))
    : [];

  // ── 3. The lock write — always. files exclude package.json / eden-lock.json (they're merges). ──
  const entry: InstallEntry = {
    id: manifest.id,
    type: manifest.type,
    name: manifest.name,
    version: manifest.version,
    hash: templateContentHash(template),
    registry: ctx.registry,
    member,
    files: [...newPaths].filter((p) => !MERGED_FILES.has(p)).sort(),
    ...(manifest.dependencies ? { dependencies: manifest.dependencies } : {}),
  };
  writes.push({
    path: "eden-lock.json",
    content: serializeLock(upsertInstall(ctx.lock, entry)),
  });

  return {
    writes,
    deletions,
    conflicts,
    warnings,
    isUpdate,
    secrets: (manifest.secrets ?? []).map((s) => ({
      name: s.name,
      description: s.description,
    })),
  };
}

/**
 * Plan an uninstall (PRD §7.8): delete the entry's owned files, drop it from the lock, and hand
 * back the npm packages it recorded so the reviewer can prune them (we deliberately leave deps —
 * they may be shared with hand-written code). Deletions are intersected with what's actually on
 * the branch so we never stage a delete for a file the customer already removed by hand.
 */
export function planUninstall(ctx: {
  lock: EdenLock;
  id: string;
  memberName: string | null;
  repoPaths: string[];
}): {
  deletions: string[];
  lockWrite: { path: string; content: string };
  depsLeft: string[];
  notFound: boolean;
} {
  const entry = findInstall(ctx.lock, ctx.id, ctx.memberName);
  if (!entry) {
    return {
      deletions: [],
      lockWrite: { path: "eden-lock.json", content: serializeLock(ctx.lock) },
      depsLeft: [],
      notFound: true,
    };
  }
  const deletions = entry.files.filter((f) => ctx.repoPaths.includes(f));
  const nextLock = removeInstall(ctx.lock, ctx.id, ctx.memberName);
  return {
    deletions,
    lockWrite: { path: "eden-lock.json", content: serializeLock(nextLock) },
    depsLeft: Object.keys(entry.dependencies ?? {}),
    notFound: false,
  };
}
