/**
 * The marketplace template format — the contract of PRD §7.8 ("Recruit — the marketplace").
 *
 * A template is *files + a manifest*. This module defines that manifest (`template.json`) and
 * the catalog index (`index.json`) as Zod schemas, and it is the SINGLE source of truth for the
 * format: the catalog CI (`marketplace/scripts/validate.mjs`) and Eden's own catalog readers
 * (`app/seams/oss/catalog.*`) both validate against these rules. (The CI script re-implements
 * them in plain Node so `marketplace/` can travel to the eve OSS repo self-contained — that
 * duplication is deliberate and flagged there.)
 *
 * Client-safe: pure Zod + types, no server imports, so route components and loaders alike can
 * reference the inferred types.
 *
 * The one rule with teeth is `files`: these paths get materialized into customer repositories
 * during install (phase 2), so path traversal must be impossible at the schema layer — absolute
 * paths, `..` segments, and backslashes are rejected here, not downstream.
 */
import { z } from "zod";

/**
 * The hierarchy levels a template can target (PRD §7.8 — "turtles all the way down"). `channel`
 * and `connection` join the original four as first-class marketplace artifacts (composition): a
 * channel like Discord is defined ONCE and included by reference into agent templates. Like
 * tool/skill/subagent they install INTO an existing member; only `agent` installs as a new one.
 */
export const TEMPLATE_TYPES = [
  "tool",
  "skill",
  "subagent",
  "channel",
  "connection",
  "agent",
] as const;
export type TemplateType = (typeof TEMPLATE_TYPES)[number];

/**
 * Types a template may `includes`-reference: everything except `agent`. An agent is a whole team
 * member — it installs as its own root, so it can't be flattened into a parent's file tree.
 */
export const INCLUDABLE_TYPES = TEMPLATE_TYPES.filter(
  (t) => t !== "agent",
) as Exclude<TemplateType, "agent">[];
export type IncludableType = (typeof INCLUDABLE_TYPES)[number];

/** kebab-case slug: lowercase, digits, single hyphens; matches the on-disk directory name. */
const slug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be a kebab-case slug");

/** Semver `x.y.z` — validated by regex; we deliberately don't pull in a semver package. */
const semver = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, "must be a semver version (x.y.z)");

/**
 * A relative install path. Rejects the three traversal vectors — absolute paths, `..`
 * segments, and backslashes — because these strings become file writes in a customer repo.
 */
const relativeFilePath = z
  .string()
  .min(1)
  .refine(
    (p) => !p.startsWith("/"),
    "must be a relative path (no leading slash)",
  )
  .refine((p) => !p.includes("\\"), "must use forward slashes")
  .refine(
    (p) => !p.split("/").includes(".."),
    "must not contain '..' path segments",
  );

/** UPPER_SNAKE_CASE — the env-var convention for a required secret name. */
const secretName = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]*$/, "must be UPPER_SNAKE_CASE");

/** An npm package name (loose validation — we only merge it into package.json, never resolve it). */
const npmName = z.string().min(1).max(214);

const sandboxSetupSchema = z.object({
  /**
   * Shell commands run once while eve builds the reusable sandbox template. Use this for
   * CLIs and browser/runtime dependencies the agent should have before a turn starts.
   */
  bootstrap: z.array(z.string().min(1)).optional(),
  /** Extra environment defaults forwarded to the sandbox backend. */
  env: z.record(z.string().min(1), z.string()).optional(),
  /** External version/input key that should force eve to rebuild the sandbox template. */
  revalidationKey: z.string().min(1).optional(),
});

export const templateManifestSchema = z.object({
  id: slug,
  type: z.enum(TEMPLATE_TYPES),
  name: z.string().min(1),
  description: z.string().min(1),
  version: semver,
  /** A semver *range* the template targets (e.g. ">=0.1.0") — opaque here; we never parse ranges. */
  eve: z.string().min(1),
  /** Non-empty list of install-relative paths the template ships. */
  files: z.array(relativeFilePath).min(1),
  /** npm name → version range, JSON-merged into the target's package.json at install (PRD §7.8). */
  dependencies: z.record(npmName, z.string().min(1)).optional(),
  /**
   * Secrets the template needs, by name — the wizard collects values at install. `sandbox: true`
   * marks one for the agent's sandbox shell (EDEN_SANDBOX_ENV convention): the install flips the
   * exposure flag so terminal-driven agents get their credentials without a manual Settings trip.
   */
  secrets: z
    .array(
      z.object({
        name: secretName,
        description: z.string().optional(),
        sandbox: z.boolean().optional(),
      }),
    )
    .optional(),
  /** Declared external connections (future use — reserved by the format now). */
  connections: z.array(z.string().min(1)).optional(),
  /** Sandbox setup installed alongside this template, merged by Eden into the agent sandbox. */
  sandbox: sandboxSetupSchema.optional(),
  /** Suggested model, for agent-type templates. */
  model: z.string().optional(),
  /**
   * Other catalog templates this one bundles by reference (composition). At install/update time
   * the resolver (compose.server.ts) flattens each include's files/deps/secrets/sandbox into this
   * template, so installed repos get materialized files — never live references. No version
   * pinning: includes resolve from the same catalog snapshot the parent came from, and the
   * parent's own version bump is what delivers newer included artifacts. `agent` is not includable
   * (a whole team member can't flatten into a parent); cycles and path collisions are CI failures.
   */
  includes: z
    .array(
      z.object({
        type: z.enum(
          INCLUDABLE_TYPES as [IncludableType, ...IncludableType[]],
        ),
        id: slug,
      }),
    )
    .optional(),
});

export type TemplateManifest = z.infer<typeof templateManifestSchema>;

/** One row of the catalog index — the browse-list projection (PRD §7.8: "browse from index.json"). */
export const catalogEntrySchema = z.object({
  id: slug,
  type: z.enum(TEMPLATE_TYPES),
  name: z.string().min(1),
  version: semver,
  description: z.string().min(1),
  /** Hex content hash of the template (manifest + sorted file contents) — drift detection. */
  hash: z.string().regex(/^[0-9a-f]+$/, "must be a hex hash"),
});

export type CatalogEntry = z.infer<typeof catalogEntrySchema>;

export const catalogIndexSchema = z.object({
  templates: z.array(catalogEntrySchema),
});

export type CatalogIndex = z.infer<typeof catalogIndexSchema>;

/**
 * Whether a string is a valid template id (kebab-case slug). Route loaders MUST gate URL
 * params through this before handing them to a CatalogSource — the fixture impl joins the id
 * into a filesystem path, so an unvalidated id is a path-traversal vector.
 */
export function isTemplateSlug(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

/** Parse+validate an unknown value as a TemplateManifest, throwing zod's error on failure. */
export function parseManifest(json: unknown): TemplateManifest {
  return templateManifestSchema.parse(json);
}

/** Parse+validate an unknown value as a CatalogIndex, throwing zod's error on failure. */
export function parseIndex(json: unknown): CatalogIndex {
  return catalogIndexSchema.parse(json);
}
