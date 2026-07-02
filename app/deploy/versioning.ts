/**
 * Pure version-labelling helpers for the release registry (D9). No I/O — the DB count is passed
 * in — so these are unit-tested directly and the controller just wires them to persistence.
 */

/** The `vN` label for the Nth release of a project, given how many already exist. */
export function versionLabel(existingCount: number): string {
  return `v${existingCount + 1}`;
}

/**
 * Is `err` a unique-violation on the (project, version) release label? Drizzle wraps the driver
 * error, so walk the cause chain rather than matching the top-level message. Two concurrent
 * release creates race on the label; the caller retries with a fresh count when this is true.
 */
export function isVersionLabelCollision(err: unknown): boolean {
  for (let e: unknown = err; e instanceof Error; e = e.cause) {
    const pg = e as Error & { code?: string; constraint_name?: string };
    if (pg.code === "23505" && pg.constraint_name === "releases_project_version_uq") {
      return true;
    }
  }
  return false;
}
