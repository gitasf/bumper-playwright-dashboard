import { describe, expect, it } from "vite-plus/test";
import {
  STATUS,
  type Status,
  statusCssVar,
  statusGroupKey,
  statusLabel,
  statusSortKey,
  statusToken,
} from "@/lib/status";

/**
 * Pins the unified status registry that replaced four conflicting per-component
 * encodings (raw hex in lib/status.ts, `var(--…)` inline in ~6 components,
 * Badge variants in status-badge, Tailwind `bg-*` classes in run/filter-bar).
 * Every presentation accessor now derives from `STATUS`, so these tests are the
 * single guard against a maintainer drifting one component's colour/label/order
 * out of agreement with the rest.
 */

const ALL_STATUSES = Object.keys(STATUS) as Status[];

describe("STATUS registry", () => {
  it("models the six Playwright outcome statuses", () => {
    expect(new Set(ALL_STATUSES)).toEqual(
      new Set([
        "passed",
        "failed",
        "flaky",
        "skipped",
        "timedout",
        "interrupted",
      ]),
    );
  });

  it("references CSS custom-property names, never raw colour literals", () => {
    // styles.css is the sole owner of the resolved oklch values — the registry
    // must only carry the token name so theming/dark-mode keep working.
    for (const status of ALL_STATUSES) {
      expect(STATUS[status].cssVar).toMatch(/^--[a-z]+$/);
    }
  });
});

describe("statusToken", () => {
  it("wraps the registry token in a var(...) reference", () => {
    expect(statusToken("passed")).toBe("var(--pass)");
    expect(statusToken("failed")).toBe("var(--fail)");
    expect(statusToken("flaky")).toBe("var(--flaky)");
    expect(statusToken("skipped")).toBe("var(--skipped)");
  });

  it("collapses timedout onto the fail token and interrupted onto flaky", () => {
    expect(statusToken("timedout")).toBe(statusToken("failed"));
    expect(statusToken("interrupted")).toBe(statusToken("flaky"));
  });

  it("falls back to a muted neutral for unknown statuses", () => {
    expect(statusToken("queued")).toBe("var(--muted-foreground)");
    expect(statusToken("totally-unknown")).toBe("var(--muted-foreground)");
  });
});

describe("statusLabel", () => {
  it("returns the registry's human label", () => {
    expect(statusLabel("passed")).toBe("Passed");
    expect(statusLabel("timedout")).toBe("Timed out");
    expect(statusLabel("interrupted")).toBe("Interrupted");
  });

  it("title-cases unknown statuses rather than throwing", () => {
    expect(statusLabel("queued")).toBe("Queued");
  });
});

describe("statusCssVar", () => {
  it("maps each status to its css token name", () => {
    expect(statusCssVar("passed")).toBe("--pass");
    expect(statusCssVar("failed")).toBe("--fail");
    expect(statusCssVar("timedout")).toBe("--fail");
    expect(statusCssVar("flaky")).toBe("--flaky");
    expect(statusCssVar("interrupted")).toBe("--flaky");
    expect(statusCssVar("skipped")).toBe("--skipped");
  });

  it("falls back to the neutral skipped pair for unknown statuses", () => {
    expect(statusCssVar("queued")).toBe("--skipped");
  });
});

describe("statusSortKey", () => {
  it("orders worst-status-first (failed < timedout < flaky < interrupted < skipped < passed)", () => {
    expect(statusSortKey("failed")).toBeLessThan(statusSortKey("timedout"));
    expect(statusSortKey("timedout")).toBeLessThan(statusSortKey("flaky"));
    expect(statusSortKey("flaky")).toBeLessThan(statusSortKey("interrupted"));
    expect(statusSortKey("interrupted")).toBeLessThan(statusSortKey("skipped"));
    expect(statusSortKey("skipped")).toBeLessThan(statusSortKey("passed"));
  });

  it("sorts unknown statuses last", () => {
    expect(statusSortKey("queued")).toBeGreaterThan(statusSortKey("passed"));
  });
});

describe("statusGroupKey", () => {
  it("keeps the four user-facing buckets as themselves", () => {
    expect(statusGroupKey("passed")).toBe("passed");
    expect(statusGroupKey("failed")).toBe("failed");
    expect(statusGroupKey("flaky")).toBe("flaky");
    expect(statusGroupKey("skipped")).toBe("skipped");
  });

  it("collapses timedout into failed and interrupted into flaky", () => {
    expect(statusGroupKey("timedout")).toBe("failed");
    expect(statusGroupKey("interrupted")).toBe("flaky");
  });

  it("returns null for statuses not in the registry (queued, unknown)", () => {
    // queued is the in-flight placeholder ingest prefills; it must NOT count
    // in any of the four user-facing chips (Passed/Failed/Flaky/Skipped).
    // Unknown future statuses also get null so callers can skip them cleanly.
    expect(statusGroupKey("queued")).toBeNull();
    expect(statusGroupKey("totally-unknown")).toBeNull();
  });

  it("every registry status collapses into one of the four buckets", () => {
    // groupKey is derived from the shared `status-buckets` spec (re-exported
    // here), not stored on the registry entry — so this asserts every status
    // the registry models has a bucket in that spec.
    const buckets = new Set(["passed", "failed", "flaky", "skipped"]);
    for (const status of ALL_STATUSES) {
      const group = statusGroupKey(status);
      expect(group !== null && buckets.has(group)).toBe(true);
    }
  });
});
