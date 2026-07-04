/**
 * Cron preset abstraction + markdown schedule file round-trip — the pure logic behind the
 * schedule editor. Pins: preset⇄expression round-trips, unknown shapes stay custom (never
 * lossy), and frontmatter keys the editor doesn't own survive a save.
 */
import { describe, expect, it } from "vitest";

import { buildScheduleFile, parseScheduleFile } from "~/eve/scheduleFile";
import { buildCron, describeCron, isValidCron, parseCron } from "~/lib/cron";

describe("cron presets", () => {
  it.each([
    ["*/5 * * * *", { kind: "every-minutes", n: 5 }],
    ["30 * * * *", { kind: "hourly", minute: 30 }],
    ["0 9 * * *", { kind: "daily", hour: 9, minute: 0 }],
    ["15 17 * * 1-5", { kind: "weekdays", hour: 17, minute: 15 }],
    ["0 8 * * 1", { kind: "weekly", weekday: 1, hour: 8, minute: 0 }],
    ["0 6 15 * *", { kind: "monthly", day: 15, hour: 6, minute: 0 }],
  ] as const)("recognizes %s and round-trips it", (expr, preset) => {
    expect(parseCron(expr)).toEqual(preset);
    expect(buildCron(parseCron(expr))).toBe(expr);
  });

  it("keeps unrecognized shapes as custom without mangling them", () => {
    const expr = "0 9 * 2 3"; // month-scoped — no preset
    expect(parseCron(expr)).toEqual({ kind: "custom", expression: expr });
    expect(buildCron(parseCron(expr))).toBe(expr);
  });

  it("describes presets in plain English", () => {
    expect(describeCron("0 9 * * 1-5")).toBe("Weekdays at 09:00");
    expect(describeCron("*/15 * * * *")).toBe("Every 15 minutes");
    expect(describeCron("0 6 1 * *")).toBe("Monthly on day 1 at 06:00");
  });

  it("validates 5-field structure", () => {
    expect(isValidCron("0 9 * * *")).toBe(true);
    expect(isValidCron("0 9 * *")).toBe(false);
    expect(isValidCron("banana * * * *")).toBe(false);
  });
});

describe("schedule markdown files", () => {
  it("parses cron frontmatter + message body", () => {
    const f = parseScheduleFile('---\ncron: "0 9 * * 1-5"\n---\n\nDo the thing.\n');
    expect(f).toEqual({
      cron: "0 9 * * 1-5",
      message: "Do the thing.",
      extraFrontmatter: [],
    });
  });

  it("round-trips and PRESERVES frontmatter keys the editor doesn't own", () => {
    const src = '---\ncron: "0 9 * * *"\ntimezone: Australia/Sydney\n---\n\nHello.\n';
    const parsed = parseScheduleFile(src);
    expect(parsed.extraFrontmatter).toEqual(["timezone: Australia/Sydney"]);
    const rebuilt = buildScheduleFile({ ...parsed, cron: "30 8 * * *" });
    expect(rebuilt).toBe(
      '---\ncron: "30 8 * * *"\ntimezone: Australia/Sydney\n---\n\nHello.\n',
    );
  });

  it("treats a file without frontmatter as message-only (cron empty)", () => {
    const f = parseScheduleFile("Just a body.");
    expect(f.cron).toBe("");
    expect(f.message).toBe("Just a body.");
  });
});
