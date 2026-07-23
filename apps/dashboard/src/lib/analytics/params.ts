import { parseBranchParam } from "@/components/run/history-branch-filter.shared";
import { DAY_SEC } from "./bucketing";
import { rangeToSeconds } from "./range";

/**
 * Resolved branch-filter triple for an analytics loader.
 *
 * - `branchParam` is the raw `?branch=` value (or `null` when absent), echoed
 *   back to props so the branch picker can keep its selection.
 * - `branchFilter` is the value to filter queries by, with the `__all__`
 *   sentinel and absent params both folded to `null` (no filter).
 * - `branchAll` is `true` when no branch filter is active — flaky.server.ts
 *   surfaces this directly; other loaders can ignore it.
 */
export interface BranchFilter {
  branchParam: string | null;
  branchFilter: string | null;
  branchAll: boolean;
}

/**
 * Fold the `?branch=` decode the analytics loaders all repeat — the
 * `parseBranchParam` call plus the `branchFilter === null` ("all branches")
 * derivation — into one place. Wraps {@link parseBranchParam} so the sentinel
 * decode rule still has its single owner; this just packages the three values
 * loaders used to derive inline (`branchParam`, `branchFilter`, and flaky's
 * `branchAll`).
 */
export function normalizeBranchFilter(
  branchParam: string | null | undefined,
): BranchFilter {
  const param = branchParam ?? null;
  const branchFilter = parseBranchParam(param);
  return { branchParam: param, branchFilter, branchAll: branchFilter === null };
}

/** The time window an analytics query covers, derived once from a range key. */
export interface AnalyticsWindow {
  /** Current time in unix seconds — the upper bound of the window. */
  nowSec: number;
  /**
   * Lower bound in unix seconds. `0` for the "all time" range (`rangeSec`
   * null) so the window stretches back to the epoch; otherwise
   * `nowSec - rangeSec`.
   */
  windowStartSec: number;
  /** Window length in whole days, or `null` for the "all time" range. */
  days: number | null;
  /** Window length in seconds from {@link rangeToSeconds}, or `null` for "all". */
  rangeSec: number | null;
}

/**
 * Apply the ONE canonical analytics window formula to an already-parsed range
 * key. Callers keep their own range parser (`makeRangeParser` / `z.enum`) and
 * pass the narrowed string here, so this fits both the raw-`searchParams`
 * loaders and the typed-query (`withValidator`) path equally.
 *
 * Window contract (reconciling the three hand-rolled variants that had drifted
 * apart): `windowStartSec = rangeSec == null ? 0 : nowSec - rangeSec`. The
 * 30-day fallback the insights/run-duration loaders carried was dead code —
 * their range sets never include `"all"`, so `rangeSec` is never null there —
 * and the 0-fallback already matched suite-size / slowest-tests / tests.
 *
 * `nowSec` is injectable so the window math is unit-testable without mocking
 * the clock.
 */
export function resolveAnalyticsWindow(
  range: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): AnalyticsWindow {
  const rangeSec = rangeToSeconds(range) ?? null;
  return {
    nowSec,
    windowStartSec: rangeSec == null ? 0 : nowSec - rangeSec,
    days: rangeSec == null ? null : rangeSec / DAY_SEC,
    rangeSec,
  };
}
