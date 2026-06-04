import type { TestCase, TestResult } from "@playwright/test/reporter";

/** One test's buffered attempts, keyed by `test.id` until the test is done. */
export interface PendingTest {
  test: TestCase;
  results: TestResult[];
}

/**
 * A test attempt is "done" — no further retries will arrive — when it passed,
 * was skipped, was interrupted, or it was the final configured retry. This is
 * the gate the accumulator buffers against; `buildPayload` later aggregates the
 * buffered attempts into a single row.
 */
export function isTestDone(test: TestCase, result: TestResult): boolean {
  if (result.status === "passed") return true;
  if (result.status === "skipped") return true;
  if (result.status === "interrupted") return true;
  // Final attempt: no more retries configured.
  return result.retry >= test.retries;
}

/**
 * Owns the buffer-until-final-retry state for the reporter. Playwright fires
 * `onTestEnd` once per attempt; we accumulate attempts per test (keyed by
 * `test.id`) and only surface a test as "done" once {@link isTestDone} fires
 * for the final attempt — at which point retries can be aggregated into a
 * single `flaky` row downstream by `buildPayload`.
 *
 * This concentrates the get-or-create / push / done-gate / delete lifecycle
 * that would otherwise be smeared across `onTestEnd` plus the `onEnd` fallback
 * drain, and exposes the `{ test, results }` seam that `buildPayload` already
 * consumes — making "two fails then a pass → one done entry, removed from
 * pending" a direct unit assertion with no stubbed fetch.
 */
export class TestAccumulator {
  private pending: Map<string, PendingTest> = new Map();

  /**
   * Buffer an attempt. Returns the completed `{ test, results }` entry (and
   * removes it from the pending map) when the test reaches its final outcome;
   * otherwise returns `undefined` while more retries are expected.
   */
  record(test: TestCase, result: TestResult): PendingTest | undefined {
    const key = makeTestKey(test);
    const entry = this.pending.get(key) ?? { test, results: [] };
    entry.results.push(result);
    this.pending.set(key, entry);

    if (!isTestDone(test, result)) return undefined;

    this.pending.delete(key);
    return entry;
  }

  /**
   * Yield every test still buffered (its "done" trigger never fired — e.g. an
   * interrupted worker killed the run mid-attempt) and clear the map. Used by
   * the `onEnd` fallback flush so partial data is reported rather than lost.
   */
  drainPending(): PendingTest[] {
    const entries = [...this.pending.values()];
    this.pending.clear();
    return entries;
  }
}

function makeTestKey(test: TestCase): string {
  // Playwright assigns a stable `id` per test per run.
  return test.id;
}
