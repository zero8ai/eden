/** Human-readable duration: "—" when null, "850ms" under a second, else "1.2s". */
export function formatMs(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
