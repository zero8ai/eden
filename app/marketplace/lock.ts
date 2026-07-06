/**
 * `eden-lock.json` — the install provenance ledger (PRD §7.8 "Update-from-source"),
 * generalizing the skills-lock idea to every hierarchy level.
 *
 * One record per install: what was installed, at what version, from where, and — the load-
 * bearing part — the FINAL repo-relative paths of the files it owns. We record final paths
 * (not template-relative ones) deliberately: uninstall and update both need to know exactly
 * which bytes on disk are the template's, and that ground truth has to survive a roster rename
 * (a member `pm` → `product` moves `agents/pm/agent/tools/x.ts` to a new home; re-deriving the
 * path from `type + member` at that moment would target the wrong file). The `member` field is
 * how a team repo attributes an install; `null` is the single-agent repo's one root agent.
 *
 * Client-safe: pure Zod + pure helpers, no server imports — the install planner and the wizard
 * route component alike reference these types. Callers treat a MISSING file as an empty lock
 * (a repo that has never installed anything has no `eden-lock.json`); malformed bytes throw.
 */
import { z } from "zod";

import { TEMPLATE_TYPES } from "./manifest";

/** The lock schema version — bumped only on a breaking shape change (migration lives here). */
export const LOCK_VERSION = 1;

/** The lock's fixed repo-root location. */
export const LOCK_PATH = "eden-lock.json";

const installEntrySchema = z.object({
  /** The template id (kebab slug) — the marketplace identity. */
  id: z.string().min(1),
  type: z.enum(TEMPLATE_TYPES),
  name: z.string().min(1),
  /** The version installed (semver x.y.z); update detection compares against the catalog. */
  version: z.string().min(1),
  /** Content hash of the installed template — matches the index row it came from. */
  hash: z.string().min(1),
  /** Where it came from: "fixture" or "github:owner/repo@ref" (the CatalogSource locator). */
  registry: z.string().min(1),
  /** Owning roster member; null = the single-agent repo's root agent. */
  member: z.string().nullable(),
  /** FINAL repo-relative paths the install owns (excludes package.json / eden-lock.json). */
  files: z.array(z.string().min(1)),
  /** The npm dependencies the install ASKED for (name → range) — uninstall lists these. */
  dependencies: z.record(z.string(), z.string()).optional(),
  /**
   * Snapshot of the template's declared secrets at install time (§4.5). This is what makes
   * "required by this template" renderable forever — surviving template upgrades per-version.
   * Old locks without the field simply produce no required-rows.
   */
  secrets: z
    .array(
      z.object({
        name: z.string().min(1),
        description: z.string().optional(),
        sandbox: z.boolean().optional(),
      }),
    )
    .optional(),
  /** Sandbox setup declared by the installed template, used to regenerate sandbox add-ons. */
  sandbox: z
    .object({
      bootstrap: z.array(z.string().min(1)).optional(),
      env: z.record(z.string().min(1), z.string()).optional(),
      revalidationKey: z.string().min(1).optional(),
    })
    .optional(),
});

export type InstallEntry = z.infer<typeof installEntrySchema>;

export const lockSchema = z.object({
  version: z.literal(LOCK_VERSION),
  installs: z.array(installEntrySchema),
});

export type EdenLock = z.infer<typeof lockSchema>;

/** A fresh, empty lock — what callers use when `eden-lock.json` is absent. */
export function emptyLock(): EdenLock {
  return { version: LOCK_VERSION, installs: [] };
}

/**
 * Parse+validate raw `eden-lock.json` bytes. Throws on malformed content (a corrupt lock is a
 * real problem the reviewer must see, not a silent reset). Callers handle the *missing*-file
 * case themselves with `emptyLock()`.
 */
export function parseLock(json: unknown): EdenLock {
  return lockSchema.parse(json);
}

/**
 * The effective lock for a repo: the staged `eden-lock.json` draft if there is one, else the
 * branch's file, else empty. A corrupt lock degrades to empty rather than crashing the surface
 * that reads it (the next install's change-set rewrites it cleanly). `repoContent` is the
 * branch's `eden-lock.json` bytes (or null when absent).
 */
export function overlayLock(
  repoContent: string | null,
  drafts: Array<{ path: string; content: string | null }>,
): EdenLock {
  const draft = drafts.find((d) => d.path === LOCK_PATH);
  const raw = draft !== undefined ? draft.content : repoContent;
  if (!raw) return emptyLock();
  try {
    return parseLock(JSON.parse(raw));
  } catch {
    return emptyLock();
  }
}

/** An install is identified by (id, member) — the same template can live under two members. */
export function findInstall(
  lock: EdenLock,
  id: string,
  member: string | null,
): InstallEntry | undefined {
  return lock.installs.find((e) => e.id === id && e.member === member);
}

/** Upsert an entry by (id, member): replaces the matching install, else appends. Pure. */
export function upsertInstall(lock: EdenLock, entry: InstallEntry): EdenLock {
  const rest = lock.installs.filter(
    (e) => !(e.id === entry.id && e.member === entry.member),
  );
  return { ...lock, installs: [...rest, entry] };
}

/** Remove the (id, member) entry, returning a new lock. Pure. */
export function removeInstall(
  lock: EdenLock,
  id: string,
  member: string | null,
): EdenLock {
  return {
    ...lock,
    installs: lock.installs.filter(
      (e) => !(e.id === id && e.member === member),
    ),
  };
}

/**
 * Serialize to stable, review-friendly JSON: installs sorted by (id, member) so a diff is
 * driven by content not insertion order, 2-space indent, trailing newline (the repo's file
 * convention — everything else in a change-set looks like this).
 */
export function serializeLock(lock: EdenLock): string {
  const installs = [...lock.installs].sort((a, b) => {
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    // Root agent (null member) sorts before named members; then lexical.
    const am = a.member ?? "";
    const bm = b.member ?? "";
    return am < bm ? -1 : am > bm ? 1 : 0;
  });
  return JSON.stringify({ version: lock.version, installs }, null, 2) + "\n";
}
