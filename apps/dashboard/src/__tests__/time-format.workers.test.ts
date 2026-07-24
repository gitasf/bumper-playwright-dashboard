import { describe, expect, it } from "vite-plus/test";
import {
  formatDateLabel,
  formatDateTabular,
  formatDuration,
  formatRelativeTime,
  toIsoDate,
} from "@/lib/time-format";

describe("formatDuration", () => {
  it("renders sub-second durations in milliseconds", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(450)).toBe("450ms");
    expect(formatDuration(999)).toBe("999ms");
  });

  it("renders 1s–59s as whole seconds (floored)", () => {
    expect(formatDuration(1000)).toBe("1s");
    expect(formatDuration(12_499)).toBe("12s");
    expect(formatDuration(59_999)).toBe("59s");
  });

  it("renders minutes with remaining seconds", () => {
    expect(formatDuration(60_000)).toBe("1m 0s");
    expect(formatDuration(63_000)).toBe("1m 3s");
    expect(formatDuration(125_500)).toBe("2m 5s");
  });
});

describe("formatRelativeTime", () => {
  // Fixed clock: 2026-01-02T00:00:00Z in ms.
  const NOW_MS = Date.UTC(2026, 0, 2, 0, 0, 0);
  const nowSec = NOW_MS / 1000;

  it("renders under a minute as 'just now'", () => {
    expect(formatRelativeTime(nowSec, NOW_MS)).toBe("just now");
    expect(formatRelativeTime(nowSec - 59, NOW_MS)).toBe("just now");
  });

  it("renders minutes ago under an hour", () => {
    expect(formatRelativeTime(nowSec - 60, NOW_MS)).toBe("1m ago");
    expect(formatRelativeTime(nowSec - 5 * 60, NOW_MS)).toBe("5m ago");
    expect(formatRelativeTime(nowSec - 59 * 60, NOW_MS)).toBe("59m ago");
  });

  it("renders hours ago under a day", () => {
    expect(formatRelativeTime(nowSec - 60 * 60, NOW_MS)).toBe("1h ago");
    expect(formatRelativeTime(nowSec - 23 * 60 * 60, NOW_MS)).toBe("23h ago");
  });

  it("renders days ago from a day onwards", () => {
    expect(formatRelativeTime(nowSec - 24 * 60 * 60, NOW_MS)).toBe("1d ago");
    expect(formatRelativeTime(nowSec - 3 * 24 * 60 * 60, NOW_MS)).toBe(
      "3d ago",
    );
  });

  it("accepts a Date as well as unix seconds", () => {
    const date = new Date(NOW_MS - 5 * 60 * 1000);
    expect(formatRelativeTime(date, NOW_MS)).toBe("5m ago");
  });
});

describe("date formats", () => {
  it("formatDateLabel spells the month so DD/MM vs MM/DD can't be misread", () => {
    expect(formatDateLabel("2026-07-06")).toBe("6 Jul 26");
    expect(formatDateLabel("2026-12-31")).toBe("31 Dec 26");
  });

  it("formatDateTabular renders sortable yyyy-MM-dd", () => {
    expect(formatDateTabular(new Date(2026, 6, 6))).toBe("2026-07-06");
  });

  it("toIsoDate matches the URL-param shape", () => {
    expect(toIsoDate(new Date(2026, 0, 2))).toBe("2026-01-02");
  });
});
