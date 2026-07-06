/** Human-readable duration: "—" when null, "850ms" under a second, else "1.2s". */
export function formatMs(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Coarse relative time for status lines ("just now", "5m ago", "2h ago", "3d ago"). */
export function timeAgo(when: string | Date): string {
  const seconds = Math.max(0, (Date.now() - new Date(when).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
