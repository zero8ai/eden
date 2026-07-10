import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  LocalizedDate,
  LocalizedDateTime,
  LocalizedNumber,
  RelativeTime,
  formatRelativeTime,
} from "~/components/localized-values";

describe("localized values server rendering", () => {
  it("renders readable date, date-time, and number fallbacks in the fixed locale and UTC", () => {
    const html = renderToString(
      <div>
        <LocalizedDate
          value="2025-01-02T03:04:05.000Z"
          options={{ month: "short", day: "numeric" }}
        />
        <LocalizedDateTime value="2025-01-02T03:04:05.000Z" />
        <LocalizedNumber value={1_234_567} />
      </div>,
    );

    expect(html).toContain("Jan 2");
    expect(html).toContain("1/2/2025, 3:04:05 AM");
    expect(html).toContain("1,234,567");
    expect(html).toContain('dateTime="2025-01-02T03:04:05.000Z"');
  });

  it("uses an exact deterministic timestamp for relative time on the server", () => {
    const html = renderToString(
      <RelativeTime value="2025-01-02T03:04:05.000Z" />,
    );

    expect(html).toContain("1/2/2025, 3:04:05 AM");
    expect(html).not.toContain("ago");
  });

  it("renders invalid dates without throwing or emitting an invalid time element", () => {
    expect(renderToString(<LocalizedDate value="not-a-date" />)).toBe("—");
    expect(renderToString(<LocalizedDateTime value="not-a-date" />)).toBe("—");
    expect(renderToString(<RelativeTime value="not-a-date" />)).toBe("—");
  });
});

describe("formatRelativeTime", () => {
  const now = "2025-01-02T00:00:00.000Z";
  const before = (milliseconds: number) =>
    new Date(new Date(now).getTime() - milliseconds);

  it.each([
    [before(59_999), "just now"],
    [before(60_000), "1m ago"],
    [before(60 * 60_000), "1h ago"],
    [before(24 * 60 * 60_000), "1d ago"],
    [before(30 * 24 * 60 * 60_000), "1mo ago"],
    [before(360 * 24 * 60 * 60_000), "1y ago"],
  ])("formats %s as %s", (value, expected) => {
    expect(formatRelativeTime(value, now)).toBe(expected);
  });

  it("clamps future values and rejects invalid input", () => {
    expect(formatRelativeTime("2025-01-03T00:00:00.000Z", now)).toBe(
      "just now",
    );
    expect(formatRelativeTime("not-a-date", now)).toBe("");
  });
});
