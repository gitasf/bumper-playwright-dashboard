import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BatchExecutor } from "@/lib/db-batch";

// Mechanism A (the verified email.workers.test.ts:18-25 pattern): back `void/env`
// with a mutable config object created in `vi.hoisted` — so it's initialized
// ABOVE the hoisted `vi.mock` factory that captures it by reference — then drive
// `billingEnabled(env)` between its two states by mutating `config.POLAR_*` in
// each describe's beforeEach. `tierLimits` reads the AMBIENT `env`, so this mock
// is the only way to exercise the load-bearing billing-off-⇒-unlimited assertion.
// The pure-function describes below (evaluateQuota/formatBytes/…) read no env, so
// the mock is inert for them.
const { config } = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
}));
vi.mock("void/env", () => ({ env: config }));

// Imported AFTER the vi.mock so they read the mocked env (vitest hoists vi.mock
// above imports).
import {
  evaluateQuota,
  formatBytes,
  monthStartSeconds,
  tierLimits,
  usageBumpStatement,
} from "@/lib/usage";
import {
  BILLING_PERIOD_GRACE_SECONDS,
  effectiveTier,
} from "@/lib/billing/tier";

/**
 * The pure core of usage metering / quota enforcement, plus the tier→limit
 * mapping (`tierLimits`) and the expiry gate (`effectiveTier`). The DB-touching
 * paths (`checkQuota`, `loadTeamUsage`, `reconcileUsage`) are exercised
 * end-to-end by the pg-integration + e2e suites; these guard the arithmetic +
 * the OSS-safety billing-off short-circuit that decide whether ingest is allowed.
 */

beforeEach(() => {
  // Arbitrary TEST values, read back from `config` by the billing-ON assertions
  // (NOT the real env.ts defaults). Free vs Pro values are deliberately distinct
  // so a free/pro mix-up fails the assertion. Baseline leaves POLAR_* deleted, so
  // the default state is billing-OFF; the billing-ON describe sets them itself.
  config.WRIGHTFUL_FREE_MONTHLY_RUNS = 1000;
  config.WRIGHTFUL_FREE_MONTHLY_TEST_RESULTS = 50000;
  config.WRIGHTFUL_FREE_ARTIFACT_BYTES = 5368709120;
  config.WRIGHTFUL_PRO_MONTHLY_RUNS = 25000;
  config.WRIGHTFUL_PRO_MONTHLY_TEST_RESULTS = 5000000;
  config.WRIGHTFUL_PRO_ARTIFACT_BYTES = 107374182400;
  delete config.POLAR_ACCESS_TOKEN;
  delete config.POLAR_WEBHOOK_SECRET;
});

describe("tierLimits — billing OFF (POLAR_* unset)", () => {
  // beforeEach above already leaves POLAR_* deleted → billingEnabled(env) is false.
  it("returns all-Infinity for every tier (the OSS-safety assertion — the ONLY unlimited path)", () => {
    const unlimited = {
      runs: Infinity,
      testResults: Infinity,
      artifactBytes: Infinity,
    };
    expect(tierLimits("free")).toEqual(unlimited);
    expect(tierLimits("pro")).toEqual(unlimited);
  });
});

describe("tierLimits — billing ON (both POLAR_* set)", () => {
  beforeEach(() => {
    config.POLAR_ACCESS_TOKEN = "polar_test";
    config.POLAR_WEBHOOK_SECRET = "whsec_test";
  });

  it("free reads the WRIGHTFUL_FREE_* ceilings", () => {
    expect(tierLimits("free")).toEqual({
      runs: config.WRIGHTFUL_FREE_MONTHLY_RUNS,
      testResults: config.WRIGHTFUL_FREE_MONTHLY_TEST_RESULTS,
      artifactBytes: config.WRIGHTFUL_FREE_ARTIFACT_BYTES,
    });
  });

  it("pro is CAPPED (finite WRIGHTFUL_PRO_* ceilings), NOT unlimited, when billing is ON", () => {
    const proLimits = tierLimits("pro");
    expect(proLimits).toEqual({
      runs: config.WRIGHTFUL_PRO_MONTHLY_RUNS,
      testResults: config.WRIGHTFUL_PRO_MONTHLY_TEST_RESULTS,
      artifactBytes: config.WRIGHTFUL_PRO_ARTIFACT_BYTES,
    });
    // Explicitly NOT Infinity — Pro is finite when billing is on. trial-pro
    // carries tier="pro" too, so it reads these same finite caps (no separate
    // branch — the trial/paid distinction is the polarCustomerId discriminator,
    // which tierLimits does not read).
    expect(proLimits.runs).not.toBe(Infinity);
    expect(Number.isFinite(proLimits.runs)).toBe(true);
  });
});

describe("effectiveTier", () => {
  const grace = BILLING_PERIOD_GRACE_SECONDS;

  it("keeps pro within the paid-through window, including the grace boundary", () => {
    expect(effectiveTier("pro", 1000, 1000)).toBe("pro"); // exactly at period end
    expect(effectiveTier("pro", 1000, 1000 + grace)).toBe("pro"); // at grace edge
  });

  it("downgrades an expired pro (past the grace window) to free", () => {
    expect(effectiveTier("pro", 1000, 1000 + grace + 1)).toBe("free");
  });

  it("keeps pro when no expiry is tracked (currentPeriodEnd null)", () => {
    expect(effectiveTier("pro", null, 1_000_000_000)).toBe("pro");
  });

  it("is always free for a free tier regardless of dates", () => {
    expect(effectiveTier("free", null, 1_000_000_000)).toBe("free");
    expect(effectiveTier("free", 1000, 1_000_000_000)).toBe("free");
  });
});

describe("evaluateQuota", () => {
  it("never blocks an unlimited (Infinity) limit", () => {
    // Re-asserted for the billing-OFF case, where every tier's limit is Infinity.
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
    // The all-zero-delta early return fires before `exec` is ever touched, so
    // the executor is irrelevant on this path — a sentinel typed as the now-
    // required `exec` argument keeps the assertion pure (no DB access).
    const exec = null as unknown as BatchExecutor;
    expect(usageBumpStatement("team_1", 0, {}, 0, exec)).toBeNull();
    expect(
      usageBumpStatement("team_1", 0, { runs: 0, testResults: 0 }, 0, exec),
    ).toBeNull();
  });
});
