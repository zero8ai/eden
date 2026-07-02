/**
 * Pure weighted-split selection for the ingress traffic splitter (D9/D10). Extracted from the
 * proxy so it's unit-tested without a socket: given the live deployments and a roll in [0,1),
 * choose one proportional to its (non-negative) weight. Session-stickiness is the proxy's job;
 * this only steers NEW sessions.
 */

export interface Weighted {
  id: string;
  trafficWeight: number;
}

/**
 * Pick one deployment proportional to weight. `rng` returns a float in [0,1) (default
 * Math.random); inject a fixed value in tests. When all weights are 0 (or the list is short)
 * it falls back to the first row so an all-drained environment still resolves deterministically.
 */
export function pickWeighted<T extends Weighted>(
  rows: T[],
  rng: () => number = Math.random,
): T | null {
  if (rows.length === 0) return null;
  const total = rows.reduce((s, r) => s + Math.max(0, r.trafficWeight), 0);
  if (total <= 0) return rows[0];
  let roll = rng() * total;
  for (const r of rows) {
    roll -= Math.max(0, r.trafficWeight);
    if (roll < 0) return r;
  }
  return rows[rows.length - 1];
}
