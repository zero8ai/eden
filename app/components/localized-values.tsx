import { useSyncExternalStore, type ReactNode } from "react";

const FALLBACK_LOCALE = "en-US";
const FALLBACK_TIME_ZONE = "UTC";

const subscribe = () => () => {};
const getClientSnapshot = () => true;
const getServerSnapshot = () => false;

type DateValue = string | number | Date;

function useHydrated(): boolean {
  return useSyncExternalStore(subscribe, getClientSnapshot, getServerSnapshot);
}

function validDate(value: DateValue): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(
  date: Date,
  hydrated: boolean,
  options: Intl.DateTimeFormatOptions,
): string {
  return new Intl.DateTimeFormat(
    hydrated ? undefined : FALLBACK_LOCALE,
    hydrated ? options : { ...options, timeZone: FALLBACK_TIME_ZONE },
  ).format(date);
}

interface LocalizedDateProps {
  value: DateValue;
  options?: Intl.DateTimeFormatOptions;
  invalidFallback?: ReactNode;
}

/** A browser-local date with a deterministic UTC rendering through first hydration. */
export function LocalizedDate({
  value,
  options,
  invalidFallback = "—",
}: LocalizedDateProps) {
  const hydrated = useHydrated();
  const date = validDate(value);
  if (!date) return invalidFallback;

  const formatted = formatDate(
    date,
    hydrated,
    options ?? { year: "numeric", month: "numeric", day: "numeric" },
  );
  return <time dateTime={date.toISOString()}>{formatted}</time>;
}

/** A browser-local date and time with a deterministic UTC rendering through first hydration. */
export function LocalizedDateTime({
  value,
  options,
  invalidFallback = "—",
}: LocalizedDateProps) {
  const hydrated = useHydrated();
  const date = validDate(value);
  if (!date) return invalidFallback;

  const formatted = formatDate(
    date,
    hydrated,
    options ?? {
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    },
  );
  return <time dateTime={date.toISOString()}>{formatted}</time>;
}

interface LocalizedNumberProps {
  value: number;
  options?: Intl.NumberFormatOptions;
}

/** A browser-local number with a deterministic locale through first hydration. */
export function LocalizedNumber({ value, options }: LocalizedNumberProps) {
  const hydrated = useHydrated();
  return new Intl.NumberFormat(
    hydrated ? undefined : FALLBACK_LOCALE,
    options,
  ).format(value);
}

/** Coarse relative time for status lines, with an injectable clock for deterministic tests. */
export function formatRelativeTime(
  value: DateValue,
  now: DateValue = Date.now(),
): string {
  const date = validDate(value);
  const reference = validDate(now);
  if (!date || !reference) return "";

  const seconds = Math.max(
    0,
    Math.floor((reference.getTime() - date.getTime()) / 1000),
  );
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

interface RelativeTimeProps {
  value: DateValue;
  invalidFallback?: ReactNode;
}

/**
 * A coarse browser-relative timestamp after hydration. SSR and first hydration use an exact,
 * readable UTC timestamp so server output never depends on the host clock or locale.
 */
export function RelativeTime({
  value,
  invalidFallback = "—",
}: RelativeTimeProps) {
  const hydrated = useHydrated();
  const date = validDate(value);
  if (!date) return invalidFallback;

  const exact = formatDate(date, hydrated, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });

  return (
    <time dateTime={date.toISOString()} title={exact}>
      {hydrated ? formatRelativeTime(date) : exact}
    </time>
  );
}
