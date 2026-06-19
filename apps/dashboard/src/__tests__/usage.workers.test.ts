import { describe, expect, it } from "vite-plus/test";
import {
  evaluateQuota,
  formatBytes,
  monthStartSeconds,
  usageBumpStatement,
} from "@/lib/usage";

/**
 * The pure core of usage metering / quota enforcement. The DB-touching paths
 * (`checkQuota`, `loadTeamUsage`, `reconcileUsage`) are exercised end-to-end by
 * the e2e dogfood suite; these guard the arithmetic that decides whether ingest
 * is allowed and how usage is displayed.
 */

describe("evaluateQuota", () => {
  it("never blocks an unlimited (Infinity) limit", () => {
    expect(evaluateQuota(1e9, 1, Infinity, 90)).toBe("ok");
  });

  it("allows usage up to and including the limit, blocks past it", () => {
    // 1000-run limit: the 1000th run is allowed, the 1001st is blocked.
    expect(evaluateQuota(999, 1, 1000, 90)).toBe("softWarn"); // projected 1000
    expect(evaluateQuota(1000, 1, 1000, 90)).toBe("blocked"); // projected 1001
  });

  it("soft-warns once projected usage crosses the warn percentage", () => {
    expect(evaluateQuota(10, 1, 1000, 90)).toBe("ok"); // 11 < 900
    expect(evaluateQuota(899, 1, 1000, 90)).toBe("softWarn"); // 900 >= 900
  });

  it("blocks a single oversized increment that overshoots the limit", () => {
    // artifact bytes: a fresh 2 GiB upload against a 1 GiB allowance.
    expect(evaluateQuota(0, 2_000_000_000, 1_000_000_000, 90)).toBe("blocked");
  });

  it("treats a zero limit as immediately blocked", () => {
    expect(evaluateQuota(0, 1, 0, 90)).toBe("blocked");
  });
});

describe("monthStartSeconds", () => {
  it("floors to the UTC start of the containing month", () => {
    const mid = Math.floor(Date.UTC(2026, 5, 13, 12, 34, 56) / 1000);
    expect(monthStartSeconds(mid)).toBe(
      Math.floor(Date.UTC(2026, 5, 1, 0, 0, 0) / 1000),
    );
  });

  it("is idempotent on an exact month boundary", () => {
    const start = Math.floor(Date.UTC(2026, 0, 1) / 1000);
    expect(monthStartSeconds(start)).toBe(start);
  });

  it("maps the last second of a month to that month's start", () => {
    const last = Math.floor(Date.UTC(2026, 1, 28, 23, 59, 59) / 1000);
    expect(monthStartSeconds(last)).toBe(
      Math.floor(Date.UTC(2026, 1, 1) / 1000),
    );
  });
});

describe("formatBytes", () => {
  it("renders sub-KiB counts in bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(500)).toBe("500 B");
  });

  it("scales into binary units with one decimal", () => {
    expect(formatBytes(1024)).toBe("1.0 KiB");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(5 * 1024 ** 3)).toBe("5.0 GiB");
  });

  it("drops the decimal for large magnitudes within a unit", () => {
    expect(formatBytes(512 * 1024 ** 2)).toBe("512 MiB");
  });
});

describe("usageBumpStatement", () => {
  it("returns null for an all-zero delta so callers can skip appending it", () => {
    expect(usageBumpStatement("team_1", 0, {}, 0)).toBeNull();
    expect(
      usageBumpStatement("team_1", 0, { runs: 0, testResults: 0 }, 0),
    ).toBeNull();
  });
});
