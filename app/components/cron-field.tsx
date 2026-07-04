/**
 * Human-readable cron picker — the schedule editor's abstraction over raw cron. A frequency
 * dropdown plus only the fields that frequency needs (time, weekday, day-of-month); "Custom"
 * exposes the raw expression, so nothing expressible in cron is off the table. Controlled:
 * emits the cron string, and shows the plain-English reading + the expression it produced.
 */
import { useState } from "react";

import { Input } from "~/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  buildCron,
  describeCron,
  isValidCron,
  parseCron,
  WEEKDAY_NAMES,
  type CronPreset,
} from "~/lib/cron";

const FREQUENCIES = [
  { kind: "every-minutes", label: "Every few minutes" },
  { kind: "hourly", label: "Hourly" },
  { kind: "daily", label: "Daily" },
  { kind: "weekdays", label: "Weekdays" },
  { kind: "weekly", label: "Weekly" },
  { kind: "monthly", label: "Monthly" },
  { kind: "custom", label: "Custom (cron)" },
] as const;

const MINUTE_STEPS = [0, 5, 10, 15, 20, 30, 45];
const EVERY_N_OPTIONS = [5, 10, 15, 30];

/** Carry the current time fields into a newly selected frequency. */
function presetFor(kind: CronPreset["kind"], prev: CronPreset, cron: string): CronPreset {
  const hour = "hour" in prev ? prev.hour : 9;
  const minute = "minute" in prev ? prev.minute : 0;
  switch (kind) {
    case "every-minutes":
      return { kind, n: 5 };
    case "hourly":
      return { kind, minute };
    case "daily":
      return { kind, hour, minute };
    case "weekdays":
      return { kind, hour, minute };
    case "weekly":
      return { kind, weekday: 1, hour, minute };
    case "monthly":
      return { kind, day: 1, hour, minute };
    case "custom":
      return { kind, expression: cron };
  }
}

function NumberSelect({
  value,
  onChange,
  options,
  ariaLabel,
  render = String,
}: {
  value: number;
  onChange: (n: number) => void;
  options: number[];
  ariaLabel: string;
  render?: (n: number) => string;
}) {
  const all = options.includes(value)
    ? options
    : [...options, value].sort((a, b) => a - b);
  return (
    <Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
      <SelectTrigger aria-label={ariaLabel}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {all.map((n) => (
          <SelectItem key={n} value={String(n)}>
            {render(n)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const two = (n: number) => String(n).padStart(2, "0");
const HOURS = Array.from({ length: 24 }, (_, i) => i);

export function CronField({
  value,
  onChange,
}: {
  /** The cron expression. */
  value: string;
  onChange: (cron: string) => void;
}) {
  // "Custom" is sticky once chosen — otherwise typing an expression that happens to match a
  // preset would yank the UI out from under the user mid-keystroke.
  const [forceCustom, setForceCustom] = useState(false);
  const parsed = parseCron(value);
  const preset: CronPreset = forceCustom ? { kind: "custom", expression: value } : parsed;

  const set = (p: CronPreset) => onChange(buildCron(p));
  const setKind = (kind: CronPreset["kind"]) => {
    setForceCustom(kind === "custom");
    set(presetFor(kind, parsed, value));
  };

  const timeFields = "hour" in preset && (
    <>
      <span className="text-sm text-muted-foreground">at</span>
      <NumberSelect
        value={preset.hour}
        onChange={(hour) => set({ ...preset, hour })}
        options={HOURS}
        ariaLabel="Hour"
        render={two}
      />
      <span className="text-sm text-muted-foreground">:</span>
      <NumberSelect
        value={preset.minute}
        onChange={(minute) => set({ ...preset, minute })}
        options={MINUTE_STEPS}
        ariaLabel="Minute"
        render={two}
      />
    </>
  );

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={preset.kind} onValueChange={(k) => setKind(k as CronPreset["kind"])}>
          <SelectTrigger className="min-w-40" aria-label="Frequency">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FREQUENCIES.map((f) => (
              <SelectItem key={f.kind} value={f.kind}>
                {f.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {preset.kind === "every-minutes" && (
          <>
            <span className="text-sm text-muted-foreground">every</span>
            <NumberSelect
              value={preset.n}
              onChange={(n) => set({ ...preset, n })}
              options={EVERY_N_OPTIONS}
              ariaLabel="Minutes interval"
              render={(n) => `${n} min`}
            />
          </>
        )}

        {preset.kind === "hourly" && (
          <>
            <span className="text-sm text-muted-foreground">at minute</span>
            <NumberSelect
              value={preset.minute}
              onChange={(minute) => set({ ...preset, minute })}
              options={MINUTE_STEPS}
              ariaLabel="Minute past the hour"
            />
          </>
        )}

        {preset.kind === "weekly" && (
          <>
            <span className="text-sm text-muted-foreground">on</span>
            <NumberSelect
              value={preset.weekday}
              onChange={(weekday) => set({ ...preset, weekday })}
              options={[0, 1, 2, 3, 4, 5, 6]}
              ariaLabel="Day of week"
              render={(n) => WEEKDAY_NAMES[n]}
            />
          </>
        )}

        {preset.kind === "monthly" && (
          <>
            <span className="text-sm text-muted-foreground">on day</span>
            <NumberSelect
              value={preset.day}
              onChange={(day) => set({ ...preset, day })}
              options={[1, 15, 28]}
              ariaLabel="Day of month"
            />
          </>
        )}

        {(preset.kind === "daily" ||
          preset.kind === "weekdays" ||
          preset.kind === "weekly" ||
          preset.kind === "monthly") &&
          timeFields}

        {preset.kind === "custom" && (
          <Input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            aria-label="Cron expression"
            placeholder="0 9 * * 1-5"
            className="w-44 font-mono"
          />
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        {!isValidCron(value) ? (
          <span className="text-destructive">Not a valid cron expression.</span>
        ) : preset.kind === "custom" ? (
          describeCron(value)
        ) : (
          <>
            {describeCron(value)} <span className="font-mono">({value})</span>
          </>
        )}
      </p>
    </div>
  );
}
