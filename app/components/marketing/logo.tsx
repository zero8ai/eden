/**
 * The Eden brand mark + wordmark. The mark is a single leaf silhouette (garden/seed
 * motif) that inherits its color from `currentColor`, so it renders in the cornflower
 * brand token via `text-primary` and flips cleanly across the light/dark themes. Kept
 * as inline SVG so it costs no extra request and scales crisply at any size.
 */
import { cn } from "~/lib/utils";

export function EdenMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 2.25C6.4 7.4 6.4 16.6 12 21.75C17.6 16.6 17.6 7.4 12 2.25Z" />
    </svg>
  );
}

export function Logo({
  className,
  markClassName,
}: {
  className?: string;
  markClassName?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <EdenMark className={cn("h-5 w-5 text-primary", markClassName)} />
      <span className="text-xl font-medium tracking-tight">Eden</span>
    </span>
  );
}
