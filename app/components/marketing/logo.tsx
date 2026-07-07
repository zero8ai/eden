/**
 * The Eden brand mark + wordmark. The mark is the square lowercase **e** from the
 * finished brand set (see /logo). It inherits its color from `currentColor`, so it
 * renders in the cornflower brand token via `text-primary` and flips cleanly across
 * the light/dark themes. Kept as inline SVG so it costs no extra request and scales
 * crisply at any size.
 */
import { cn } from "~/lib/utils";

export function EdenMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="-18.34 -71.04 94.07 94.07"
      className={className}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M41.0 -28.8Q41.0 -31.1 40.35 -33.2Q39.7 -35.3 38.3 -36.9Q36.9 -38.5 34.75 -39.45Q32.6 -40.4 29.7 -40.4Q24.3 -40.4 20.55 -37.15Q16.8 -33.9 16.4 -28.8ZM53.0 -23.4Q53.0 -22.6 53.0 -21.8Q53.0 -21.0 52.9 -20.2H16.4Q16.6 -17.6 17.75 -15.45Q18.9 -13.3 20.8 -11.75Q22.7 -10.2 25.1 -9.3Q27.5 -8.4 30.1 -8.4Q34.6 -8.4 37.7 -10.05Q40.8 -11.7 42.8 -14.6L50.8 -8.2Q43.7 1.4 30.2 1.4Q24.6 1.4 19.9 -0.35Q15.2 -2.1 11.75 -5.3Q8.3 -8.5 6.35 -13.15Q4.4 -17.8 4.4 -23.7Q4.4 -29.5 6.35 -34.25Q8.3 -39.0 11.7 -42.35Q15.1 -45.7 19.75 -47.55Q24.4 -49.4 29.8 -49.4Q34.8 -49.4 39.05 -47.75Q43.3 -46.1 46.4 -42.85Q49.5 -39.6 51.25 -34.75Q53.0 -29.9 53.0 -23.4Z" />
    </svg>
  );
}

/**
 * The full **eden** wordmark (blue `e`, ink/off-white `den`). Two theme-specific
 * assets are shipped and CSS picks the right one, so the ink swaps to off-white on
 * dark grounds. `label` sets the accessible name (the SVGs are decorative `img`s).
 */
export function EdenWordmark({
  className,
  label = "Eden",
}: {
  className?: string;
  label?: string;
}) {
  return (
    <>
      <img
        src="/img/eden-wordmark-light.svg"
        alt={label}
        className={cn("block w-auto dark:hidden", className)}
      />
      <img
        src="/img/eden-wordmark-dark.svg"
        alt={label}
        className={cn("hidden w-auto dark:block", className)}
      />
    </>
  );
}

export function Logo({ className }: { className?: string }) {
  return <EdenWordmark className={cn("h-6", className)} label="Eden" />;
}
