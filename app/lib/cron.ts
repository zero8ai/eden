/**
 * Human-readable cron abstraction for the schedule editor (pure, client+server safe).
 *
 * Models the handful of shapes people actually schedule — every N minutes, hourly, daily,
 * weekdays, weekly, monthly — as presets that round-trip to standard 5-field cron. Anything
 * else stays a `custom` expression the UI shows raw, so no valid cron is ever unrepresentable.
 */

export type CronPreset =
  | { kind: "every-minutes"; n: number }
  | { kind: "hourly"; minute: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekdays"; hour: number; minute: number }
  | { kind: "weekly"; weekday: number; hour: number; minute: number }
  | { kind: "monthly"; day: number; hour: number; minute: number }
  | { kind: "custom"; expression: string };

export const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const int = (s: string) => /^\d+$/.test(s);

/** Recognize a cron expression as one of the friendly presets, else `custom`. */
export function parseCron(expression: string): CronPreset {
  const expr = expression.trim();
  const f = expr.split(/\s+/);
  if (f.length === 5) {
    const [min, hour, dom, mon, dow] = f;
    const everyN = min.match(/^\*\/(\d+)$/);
    if (everyN && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
      return { kind: "every-minutes", n: Number(everyN[1]) };
    }
    if (int(min) && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
      return { kind: "hourly", minute: Number(min) };
    }
    if (int(min) && int(hour) && dom === "*" && mon === "*") {
      if (dow === "*") {
        return { kind: "daily", hour: Number(hour), minute: Number(min) };
      }
      if (dow === "1-5") {
        return { kind: "weekdays", hour: Number(hour), minute: Number(min) };
      }
      if (int(dow) && Number(dow) <= 6) {
        return {
          kind: "weekly",
          weekday: Number(dow),
          hour: Number(hour),
          minute: Number(min),
        };
      }
    }
    if (int(min) && int(hour) && int(dom) && mon === "*" && dow === "*") {
      return {
        kind: "monthly",
        day: Number(dom),
        hour: Number(hour),
        minute: Number(min),
      };
    }
  }
  return { kind: "custom", expression: expr };
}

/** The cron expression for a preset. */
export function buildCron(p: CronPreset): string {
  switch (p.kind) {
    case "every-minutes":
      return `*/${p.n} * * * *`;
    case "hourly":
      return `${p.minute} * * * *`;
    case "daily":
      return `${p.minute} ${p.hour} * * *`;
    case "weekdays":
      return `${p.minute} ${p.hour} * * 1-5`;
    case "weekly":
      return `${p.minute} ${p.hour} * * ${p.weekday}`;
    case "monthly":
      return `${p.minute} ${p.hour} ${p.day} * *`;
    case "custom":
      return p.expression;
  }
}

const two = (n: number) => String(n).padStart(2, "0");
const at = (h: number, m: number) => `${two(h)}:${two(m)}`;

/** Plain-English description of a cron expression (via its preset when recognizable). */
export function describeCron(expression: string): string {
  const p = parseCron(expression);
  switch (p.kind) {
    case "every-minutes":
      return p.n === 1 ? "Every minute" : `Every ${p.n} minutes`;
    case "hourly":
      return p.minute === 0
        ? "Every hour, on the hour"
        : `Every hour at ${p.minute} past`;
    case "daily":
      return `Every day at ${at(p.hour, p.minute)}`;
    case "weekdays":
      return `Weekdays at ${at(p.hour, p.minute)}`;
    case "weekly":
      return `Every ${WEEKDAY_NAMES[p.weekday]} at ${at(p.hour, p.minute)}`;
    case "monthly":
      return `Monthly on day ${p.day} at ${at(p.hour, p.minute)}`;
    case "custom":
      return isValidCron(p.expression)
        ? `Custom: ${p.expression}`
        : "Not a valid cron expression";
  }
}

/** Loose 5-field structural validation (each field non-empty cron syntax characters). */
export function isValidCron(expression: string): boolean {
  const fields = expression.trim().split(/\s+/);
  return fields.length === 5 && fields.every((f) => /^[\d*,/-]+$/.test(f));
}
