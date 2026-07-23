import type { RunProgressEvent, RunProgressTest } from "@/realtime/events";

/** Wire-format aliases re-exported for downstream consumers. */
export type { RunProgressTest, RunProgressEvent };
export type RunProgressTestStatus = RunProgressTest["status"];
export type RunProgressSummary = RunProgressEvent["summary"];

/**
 * Accumulated state derived from a stream of `RunProgressEvent`s plus the
 * SSR-loaded seed. `byId` maps `testResultId → latest row`; `summary` is the
 * most recent aggregate snapshot (or `null` before the first event / seed).
 *
 * The run-detail analogue of `applyProjectFeedEvent` (`project-feed.ts`): a pure
 * reducer the WS run-room hook (`useRunRoom`) folds each event through, kept
 * React-free so the merge rules are unit-testable without a live connection.
 */
export interface RunProgressState {
  byId: Record<string, RunProgressTest>;
  summary: RunProgressSummary | null;
}

export interface UseRunProgressOptions {
  /** SSR-loaded test rows used to seed the accumulator before the first event. */
  initialTests?: readonly RunProgressTest[];
  /** SSR-loaded aggregate so consumers can render counts before the first event. */
  initialSummary?: RunProgressSummary | null;
}

/**
 * Seed the accumulator from SSR-loaded rows. Mirrors the producer-side
 * `buildChangedTests` (ingest.ts) as the consumer half of the same pattern:
 * both turn the wire contract into the rendered test list, and both are pure
 * so they're unit-testable without React or a live WebSocket.
 *
 * Builds `byId` from `initialTests` (last-writer-wins on duplicate ids, so a
 * later row overwrites an earlier one). `summary` defaults to `null` when no
 * `initialSummary` is supplied.
 */
export function seedRunProgressState(
  initialTests?: readonly RunProgressTest[],
  initialSummary?: RunProgressSummary | null,
): RunProgressState {
  const byId: Record<string, RunProgressTest> = {};
  if (initialTests) {
    for (const t of initialTests) byId[t.id] = t;
  }
  return { byId, summary: initialSummary ?? null };
}

/**
 * Shallow-equal two summary snapshots (all fields primitive, so per-field `===`
 * is a true shallow compare); a `null` prev is never equal. Lets the reducers
 * reuse the existing `summary` reference when an event repeats the last-seen
 * aggregate (a duplicate tick, or `changedTests` that don't shift any bucket),
 * so summary-only subscribers bail on referential equality.
 */
function summariesEqual(
  a: RunProgressSummary | null,
  b: RunProgressSummary,
): boolean {
  if (a === null) return false;
  // Keyed on the wire summary type so adding a field there is a compile error
  // here until it's compared too — a missed field would make the reducers bail
  // on a real change and freeze every summary consumer at the stale value.
  const fieldEqual: Record<keyof RunProgressSummary, boolean> = {
    totalTests: a.totalTests === b.totalTests,
    expectedTotalTests: a.expectedTotalTests === b.expectedTotalTests,
    passed: a.passed === b.passed,
    failed: a.failed === b.failed,
    flaky: a.flaky === b.flaky,
    skipped: a.skipped === b.skipped,
    durationMs: a.durationMs === b.durationMs,
    status: a.status === b.status,
    completedAt: a.completedAt === b.completedAt,
  };
  return Object.values(fieldEqual).every(Boolean);
}

/**
 * The summary reference the next state should carry: `prev` when shallow-equal
 * to `next` (see {@link summariesEqual}), else `next`. Shared by both reducers
 * so `useRunSummary` and `useRunRoom` bail on the exact same events.
 */
function nextSummary(
  prev: RunProgressSummary | null,
  next: RunProgressSummary,
): RunProgressSummary {
  return prev !== null && summariesEqual(prev, next) ? prev : next;
}

/**
 * Apply one live event to the accumulator and return the next state. Pure;
 * never mutates `prev`. Encodes the four merge rules the subscriber relies on:
 *
 *   1. Ignore non-`"progress"` events — return `prev` unchanged.
 *   2. Replace `summary` with the event's snapshot, unless shallow-equal to
 *      `prev.summary` (see {@link summariesEqual}) — then reuse `prev.summary`'s
 *      reference so a summary-only subscriber (`useRunSummary`) bails on
 *      referential equality instead of re-rendering on every wire event.
 *   3. No-op the `byId` clone when `changedTests` is empty (return the same
 *      reference). Combined with rule 2, an empty event whose summary is also
 *      unchanged returns `prev` outright — a full bail-out for every subscriber.
 *   4. Otherwise merge `changedTests` into a cloned `byId` keyed by id
 *      (last-writer-wins, so a retry's later row replaces the earlier one),
 *      still applying rule 2's summary reuse.
 *
 * Rules 2 and 3 are independent: an empty event can still advance `summary`, and
 * a non-empty event can still reuse `prev.summary` (rows changed, aggregate
 * didn't) so a `byId`-blind subscriber skips its render even though this one won't.
 */
export function applyRunProgressEvent(
  prev: RunProgressState,
  event: RunProgressEvent,
): RunProgressState {
  if (event.type !== "progress") return prev;
  const summary = nextSummary(prev.summary, event.summary);
  if (event.changedTests.length === 0) {
    if (summary === prev.summary) return prev;
    return { byId: prev.byId, summary };
  }
  const byId = { ...prev.byId };
  for (const t of event.changedTests) {
    byId[t.id] = t;
  }
  return { byId, summary };
}

/**
 * Lean accumulator for subscribers that only render the run-wide aggregate (the
 * header leaves). No `byId`: {@link applyRunSummaryEvent} never clones a per-test
 * map, so a 5,000-row run costs these subscribers a few field comparisons per
 * event instead of the ~5,000-entry spread `applyRunProgressEvent` pays.
 */
export interface RunSummaryState {
  summary: RunProgressSummary | null;
}

/** Seed the lean accumulator from the SSR-loaded aggregate — the
 * summary-only counterpart of {@link seedRunProgressState}. */
export function seedRunSummaryState(
  initialSummary?: RunProgressSummary | null,
): RunSummaryState {
  return { summary: initialSummary ?? null };
}

/**
 * Summary-only counterpart of {@link applyRunProgressEvent}: ignores
 * `changedTests` (no `byId` to merge) and applies the same summary-reuse check,
 * returning `prev` outright when the aggregate is unchanged.
 */
export function applyRunSummaryEvent(
  prev: RunSummaryState,
  event: RunProgressEvent,
): RunSummaryState {
  if (event.type !== "progress") return prev;
  const summary = nextSummary(prev.summary, event.summary);
  if (summary === prev.summary) return prev;
  return { summary };
}

/**
 * Pick the summary the header should render right now: the live snapshot once
 * any event (or the seed) has populated `state.summary`, otherwise the SSR
 * `fallback`. Pure so the "live-overrides-SSR, SSR-when-no-event" rule has one
 * unit-tested home shared by every header consumer (tiles, OutcomeBar, tab
 * count) instead of each island re-deriving the `?? fallback` coalesce.
 *
 * `state.summary` is non-null whenever `seedRunProgressState` was given an
 * `initialSummary` (the run-detail page always seeds from `run.*`), so in
 * practice the live value is returned from first paint; the `fallback` covers
 * the contract where a consumer subscribes without seeding.
 *
 * Typed over just `{ summary }` (not `RunProgressState`) so both accumulators —
 * `useRunRoom` and `useRunSummary` — share this one rule.
 */
export function currentSummary(
  state: { summary: RunProgressSummary | null },
  fallback: RunProgressSummary,
): RunProgressSummary {
  return state.summary ?? fallback;
}
