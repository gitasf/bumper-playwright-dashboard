import { ulid } from "ulid";
import { and, db, eq, inArray, sql } from "void/db";
import { logger } from "void/log";
import {
  runs,
  testAnnotations,
  testResultAttempts,
  testResults,
  testTags,
  teams,
} from "@schema";
import { runBatch } from "@/lib/db-batch";
import { runByIdWhere, staleRunFilter, type TenantScope } from "@/lib/scope";
import type {
  AppendResultsPayload,
  CompleteRunPayload,
  OpenRunPayload,
  TestResultInput,
} from "@/lib/schemas";
import {
  publishRunUpdate,
  type RunProgressEvent,
  type RunProgressTest,
} from "@/live";

/** Columns published in every `RunProgressEvent.summary`. */
export const AGGREGATE_SUMMARY_COLUMNS = {
  totalTests: runs.totalTests,
  passed: runs.passed,
  failed: runs.failed,
  flaky: runs.flaky,
  skipped: runs.skipped,
  durationMs: runs.durationMs,
  status: runs.status,
  completedAt: runs.completedAt,
} as const;

export type RunAggregateSummary = RunProgressEvent["summary"];

/**
 * Streaming ingest pipeline. Every write carries `teamId AND projectId` for
 * logical tenant isolation, and `db.batch` is the atomicity boundary (Drizzle
 * wraps D1's batch API, running every statement in a single transaction on the
 * writer node). Realtime broadcasts go through `void/live` topic `run:<runId>`.
 *
 * See `docs/worklog/void-migration-consolidated.md` for the architecture
 * decisions behind the single-D1 + `void/live` model.
 */

// D1 caps the parameter count per statement at 100. Match the previous DO
// cadence (99) so chunk sizes stay identical.
const MAX_PARAMS_PER_STATEMENT = 99;

/**
 * Slice `items` into consecutive sub-arrays of at most `size` (always ≥1, so a
 * pathological `size <= 0` still makes progress one item at a time rather than
 * looping forever). The single home for fixed-size chunking — both the D1
 * param-cap chunker (`chunkByParams`) and the watchdog's bounded-concurrency
 * drain (`drainStaleRuns`) compute their per-chunk count and hand it here.
 */
export function chunkBySize<T>(items: T[], size: number): T[][] {
  const step = Math.max(1, size);
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += step) {
    chunks.push(items.slice(i, i + step));
  }
  return chunks;
}

/**
 * Split `rows` into sub-arrays whose `.values(chunk)` multi-row insert stays
 * under D1's per-statement parameter ceiling, given the number of columns each
 * row binds. Hides the `Math.floor(99 / columnsPerRow)` arithmetic behind one
 * call so the 100-param cap lives in exactly one place.
 *
 * Prefer `chunkInsertRows` for real inserts — it derives `columnsPerRow` from
 * the row shape so the count can't drift from the row literal. This lower-level
 * form is kept for the unit test that asserts the chunking math directly.
 */
export function chunkByParams<T>(rows: T[], columnsPerRow: number): T[][] {
  return chunkBySize(
    rows,
    Math.floor(MAX_PARAMS_PER_STATEMENT / columnsPerRow),
  );
}

/**
 * Chunk insert rows for a multi-row `db.insert(table).values(chunk)`, deriving
 * the per-row column count from the row object itself (`Object.keys(row).length`)
 * — the SAME object that is handed to `.values()`. There is therefore no
 * separate hand-counted column constant that can silently drift from the row
 * shape when a column is added (the classic footgun: a nullable column makes
 * `$inferInsert` optional, so it lands in the row literal with no compile
 * error, and a stale literal count would then pack rows past the 99-param cap
 * and D1 would reject the statement at runtime).
 *
 * Every row in a batch binds the same columns (they all flow through one
 * builder), so the first row's key count governs the whole array. An empty
 * array has nothing to bind and returns no chunks.
 */
export function chunkInsertRows<T extends Record<string, unknown>>(
  rows: T[],
): T[][] {
  if (rows.length === 0) return [];
  return chunkByParams(rows, Object.keys(rows[0]).length);
}

export interface ResultMapping {
  clientKey: string;
  testResultId: string;
}

export async function resolveTestResultIds(
  scope: TenantScope,
  runId: string,
  testIds: string[],
): Promise<{
  existingIds: Map<string, string>;
  assignedIds: Map<string, string>;
  prevStatusByTestId: Map<string, string>;
}> {
  const existingIds = new Map<string, string>();
  const prevStatusByTestId = new Map<string, string>();
  if (testIds.length > 0) {
    const rows = await db
      .select({
        id: testResults.id,
        testId: testResults.testId,
        status: testResults.status,
      })
      .from(testResults)
      .where(
        and(
          eq(testResults.projectId, scope.projectId),
          eq(testResults.runId, runId),
          inArray(testResults.testId, testIds),
        ),
      );
    for (const row of rows) {
      existingIds.set(row.testId, row.id);
      prevStatusByTestId.set(row.testId, row.status);
    }
  }
  const assignedIds = new Map<string, string>();
  for (const testId of testIds) {
    assignedIds.set(testId, existingIds.get(testId) ?? ulid());
  }
  return { existingIds, assignedIds, prevStatusByTestId };
}

export function buildQueuePrefillStatements(
  scope: TenantScope,
  runId: string,
  plannedTests: ReadonlyArray<{
    testId: string;
    title: string;
    file: string;
    projectName?: string | null | undefined;
  }>,
  nowSeconds: number,
) {
  if (plannedTests.length === 0) return [];
  const rows = plannedTests.map((p) => ({
    id: ulid(),
    projectId: scope.projectId,
    runId,
    testId: p.testId,
    title: p.title,
    file: p.file,
    projectName: p.projectName ?? null,
    status: "queued",
    durationMs: 0,
    retryCount: 0,
    errorMessage: null,
    errorStack: null,
    workerIndex: null,
    createdAt: nowSeconds,
  }));
  // `onConflictDoNothing` on the (runId, testId) unique index makes prefill
  // safe to run from every shard of a sharded suite: shards share one
  // idempotencyKey (so they re-open the same run), and each shard prefills its
  // own slice of planned tests without clobbering rows another shard already
  // created or completed.
  return chunkInsertRows(rows).map((chunk) =>
    db.insert(testResults).values(chunk).onConflictDoNothing(),
  );
}

/**
 * Builds the upsert-and-replace statements for a /results batch. Returns the
 * statement array (to be passed to `db.batch`) plus the clientKey→id map the
 * reporter uses to fire per-test artifact uploads.
 *
 * Existing rows (matched on `runId, testId`) are UPDATEd in place; child
 * rows (tags, annotations, attempts) for those ids are DELETEd first so the
 * new set replaces them cleanly. Fresh rows are INSERTed in chunks.
 */
export function buildResultInsertStatements(
  scope: TenantScope,
  runId: string,
  results: TestResultInput[],
  nowSeconds: number,
  existingIds: Map<string, string>,
  assignedIds: Map<string, string>,
) {
  const insertRows: Array<{
    id: string;
    projectId: string;
    runId: string;
    testId: string;
    title: string;
    file: string;
    projectName: string | null;
    status: string;
    durationMs: number;
    retryCount: number;
    errorMessage: string | null;
    errorStack: string | null;
    workerIndex: number | null;
    createdAt: number;
  }> = [];
  const tagRows: Array<{
    id: string;
    projectId: string;
    testResultId: string;
    tag: string;
  }> = [];
  const annotationRows: Array<{
    id: string;
    projectId: string;
    testResultId: string;
    type: string;
    description: string | null;
  }> = [];
  const attemptRows: Array<{
    id: string;
    projectId: string;
    testResultId: string;
    attempt: number;
    status: string;
    durationMs: number;
    errorMessage: string | null;
    errorStack: string | null;
    createdAt: number;
  }> = [];
  const mapping: ResultMapping[] = [];
  // `PromiseLike<unknown>[]` because Drizzle batch accepts a heterogeneous
  // tuple of insert/update/delete builders; expressing the union precisely
  // fights the type system more than it helps callers. Every pushed value is
  // a thenable Drizzle query — same runtime shape.
  const statements: PromiseLike<unknown>[] = [];

  for (const result of results) {
    const testResultId = assignedIds.get(result.testId);
    if (!testResultId) continue;
    if (result.clientKey) {
      mapping.push({ clientKey: result.clientKey, testResultId });
    }

    if (existingIds.has(result.testId)) {
      statements.push(
        db
          .update(testResults)
          .set({
            title: result.title,
            file: result.file,
            projectName: result.projectName ?? null,
            status: result.status,
            durationMs: result.durationMs,
            retryCount: result.retryCount,
            errorMessage: result.errorMessage ?? null,
            errorStack: result.errorStack ?? null,
            workerIndex: result.workerIndex ?? null,
            createdAt: nowSeconds,
          })
          .where(
            and(
              eq(testResults.projectId, scope.projectId),
              eq(testResults.id, testResultId),
            ),
          ) as never,
      );
      statements.push(
        db
          .delete(testTags)
          .where(
            and(
              eq(testTags.projectId, scope.projectId),
              eq(testTags.testResultId, testResultId),
            ),
          ) as never,
      );
      statements.push(
        db
          .delete(testAnnotations)
          .where(
            and(
              eq(testAnnotations.projectId, scope.projectId),
              eq(testAnnotations.testResultId, testResultId),
            ),
          ) as never,
      );
    } else {
      insertRows.push({
        id: testResultId,
        projectId: scope.projectId,
        runId,
        testId: result.testId,
        title: result.title,
        file: result.file,
        projectName: result.projectName ?? null,
        status: result.status,
        durationMs: result.durationMs,
        retryCount: result.retryCount,
        errorMessage: result.errorMessage ?? null,
        errorStack: result.errorStack ?? null,
        workerIndex: result.workerIndex ?? null,
        createdAt: nowSeconds,
      });
    }

    // Per-attempt rows are fully owned by this result. Re-send re-creates
    // the set so the reporter staying idempotent under flush retry.
    statements.push(
      db
        .delete(testResultAttempts)
        .where(
          and(
            eq(testResultAttempts.projectId, scope.projectId),
            eq(testResultAttempts.testResultId, testResultId),
          ),
        ) as never,
    );
    for (const attempt of result.attempts) {
      attemptRows.push({
        id: ulid(),
        projectId: scope.projectId,
        testResultId,
        attempt: attempt.attempt,
        status: attempt.status,
        durationMs: attempt.durationMs,
        errorMessage: attempt.errorMessage ?? null,
        errorStack: attempt.errorStack ?? null,
        createdAt: nowSeconds,
      });
    }
    for (const tag of result.tags) {
      tagRows.push({
        id: ulid(),
        projectId: scope.projectId,
        testResultId,
        tag,
      });
    }
    for (const annotation of result.annotations) {
      annotationRows.push({
        id: ulid(),
        projectId: scope.projectId,
        testResultId,
        type: annotation.type,
        description: annotation.description ?? null,
      });
    }
  }

  for (const chunk of chunkInsertRows(insertRows)) {
    statements.push(db.insert(testResults).values(chunk));
  }
  for (const chunk of chunkInsertRows(tagRows)) {
    statements.push(db.insert(testTags).values(chunk));
  }
  for (const chunk of chunkInsertRows(annotationRows)) {
    statements.push(db.insert(testAnnotations).values(chunk));
  }
  for (const chunk of chunkInsertRows(attemptRows)) {
    statements.push(db.insert(testResultAttempts).values(chunk));
  }
  return { statements, mapping };
}

export interface AggregateDelta {
  totalTests: number;
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
}

/**
 * The single source of truth for the test-status → aggregate-bucket mapping:
 * for each non-`totalTests` column, the test statuses that feed it. Both the JS
 * delta path (`statusBucket` → `computeAggregateDelta`) and the SQL recompute
 * path (`aggregateRecomputeStatement`) derive from this one table, so the two
 * encodings cannot drift — adding a status to a bucket (or splitting one out)
 * is a one-line edit here that both sides pick up. `status-bucketing.test.ts`
 * asserts the parity structurally.
 */
export const STATUS_BUCKET_MEMBERS = {
  passed: ["passed"],
  failed: ["failed", "timedout"],
  flaky: ["flaky"],
  skipped: ["skipped"],
} as const satisfies Record<
  Exclude<keyof AggregateDelta, "totalTests">,
  readonly string[]
>;

/** Statuses → their aggregate bucket, derived from {@link STATUS_BUCKET_MEMBERS}. */
const STATUS_TO_BUCKET: ReadonlyMap<string, keyof AggregateDelta> = new Map(
  Object.entries(STATUS_BUCKET_MEMBERS).flatMap(([bucket, statuses]) =>
    statuses.map((status) => [status, bucket as keyof AggregateDelta] as const),
  ),
);

export function statusBucket(status: string): keyof AggregateDelta | null {
  return STATUS_TO_BUCKET.get(status) ?? null;
}

/**
 * Compute aggregate-column deltas given each row's previous status. Same
 * algorithm as the DO version — avoids a 5-subquery scan of the testResults
 * table on every /results batch.
 */
export function computeAggregateDelta(
  results: ReadonlyArray<{ testId: string; status: string }>,
  prevStatusByTestId: ReadonlyMap<string, string>,
): AggregateDelta {
  const delta: AggregateDelta = {
    totalTests: 0,
    passed: 0,
    failed: 0,
    flaky: 0,
    skipped: 0,
  };
  for (const r of results) {
    const prev = prevStatusByTestId.get(r.testId);
    const nextBucket = statusBucket(r.status);
    if (prev === undefined) {
      delta.totalTests += 1;
      if (nextBucket) delta[nextBucket] += 1;
      continue;
    }
    const prevBucket = statusBucket(prev);
    if (prevBucket === nextBucket) continue;
    if (prevBucket) delta[prevBucket] -= 1;
    if (nextBucket) delta[nextBucket] += 1;
  }
  return delta;
}

export function aggregateDeltaStatement(
  scope: TenantScope,
  runId: string,
  delta: AggregateDelta,
  nowSeconds: number,
) {
  if (
    delta.totalTests === 0 &&
    delta.passed === 0 &&
    delta.failed === 0 &&
    delta.flaky === 0 &&
    delta.skipped === 0
  ) {
    return null;
  }
  return db
    .update(runs)
    .set({
      totalTests: sql`${runs.totalTests} + ${delta.totalTests}`,
      passed: sql`${runs.passed} + ${delta.passed}`,
      failed: sql`${runs.failed} + ${delta.failed}`,
      flaky: sql`${runs.flaky} + ${delta.flaky}`,
      skipped: sql`${runs.skipped} + ${delta.skipped}`,
      // Bump the liveness signal in the SAME statement as the counter deltas —
      // no extra round-trip. `staleRunFilter` reads this so the watchdog can't
      // mistake an actively-streaming suite for a dead one.
      lastActivityAt: nowSeconds,
    })
    .where(runByIdWhere(scope, runId))
    .returning(AGGREGATE_SUMMARY_COLUMNS);
}

/**
 * The no-delta /results path still represents live activity (a flush whose
 * statuses net to zero bucket changes), so it must advance `lastActivityAt`
 * too — otherwise a suite that only ever re-sends already-counted results would
 * look dead to `staleRunFilter`. This bumps the liveness signal and projects
 * the broadcast summary via `.returning()`, replacing the read-only summary
 * SELECT in that branch so the bump and the snapshot stay in one statement.
 */
export function activityBumpStatement(
  scope: TenantScope,
  runId: string,
  nowSeconds: number,
) {
  return db
    .update(runs)
    .set({ lastActivityAt: nowSeconds })
    .where(runByIdWhere(scope, runId))
    .returning(AGGREGATE_SUMMARY_COLUMNS);
}

/**
 * SQL fragment matching `testResults.status` against a bucket's member
 * statuses. Single-status buckets render `"status" = 'x'`; multi-status buckets
 * render `"status" IN ('x', 'y')`. Statuses come from {@link STATUS_BUCKET_MEMBERS}
 * — a fixed in-code allowlist, never user input — so inlining the quoted
 * literals is safe (and, like {@link bucketExpr}, sidesteps D1's bound-param
 * text affinity).
 */
function statusMatchSql(statuses: readonly string[]) {
  const list = statuses.map((s) => `'${s}'`).join(", ");
  return statuses.length === 1
    ? sql.raw(`"status" = ${list}`)
    : sql.raw(`"status" IN (${list})`);
}

export function aggregateRecomputeStatement(
  scope: { projectId: string },
  runId: string,
) {
  const projectId = scope.projectId;
  const bucketCount = (statuses: readonly string[]) =>
    sql`(SELECT COUNT(*) FROM "testResults" WHERE "projectId" = ${projectId} AND "runId" = ${runId} AND ${statusMatchSql(statuses)})`;
  return db
    .update(runs)
    .set({
      totalTests: sql`(SELECT COUNT(*) FROM "testResults" WHERE "projectId" = ${projectId} AND "runId" = ${runId})`,
      passed: bucketCount(STATUS_BUCKET_MEMBERS.passed),
      failed: bucketCount(STATUS_BUCKET_MEMBERS.failed),
      flaky: bucketCount(STATUS_BUCKET_MEMBERS.flaky),
      skipped: bucketCount(STATUS_BUCKET_MEMBERS.skipped),
    })
    .where(and(eq(runs.projectId, projectId), eq(runs.id, runId)))
    .returning(AGGREGATE_SUMMARY_COLUMNS);
}

/**
 * SELECT the publishable summary inside a batch, for any caller that needs a
 * transactionally-consistent snapshot to broadcast WITHOUT writing the run row.
 *
 * The /results no-delta path used to use this, but now bumps `lastActivityAt`
 * via `activityBumpStatement` (an UPDATE with the same `.returning()` shape) so
 * even a zero-bucket-change flush registers as liveness — see
 * `appendRunResults`. This read-only variant is retained as the SELECT form of
 * a summary-producing statement (the counterpart `summaryFromBatchResults`
 * documents) for a future batch that genuinely must not touch the row.
 */
export function aggregateSummarySelectStatement(
  scope: TenantScope,
  runId: string,
) {
  return db
    .select(AGGREGATE_SUMMARY_COLUMNS)
    .from(runs)
    .where(runByIdWhere(scope, runId));
}

/**
 * Extract the publishable summary from a D1 batch result, given the invariant
 * that the summary-producing statement (an `AGGREGATE_SUMMARY_COLUMNS`
 * `.returning()` UPDATE or `aggregateSummarySelectStatement` SELECT) was run
 * LAST. `db.batch` returns one result array per statement in order, so the
 * summary row is the first element of the final result.
 *
 * This is the single owner of the "last batch row is the summary" cast. Pulled
 * out as a pure function so the positional convention has one unit-tested home
 * instead of being hand-transcribed (`batchResults[len-1] as … ?.[0]`) at every
 * caller — see `runBatchWithSummary`. Returns `null` (never a spurious
 * `undefined`) when the final statement produced no row, e.g. the run vanished
 * between the ownership check and the batch.
 */
export function summaryFromBatchResults(
  batchResults: readonly unknown[],
): RunAggregateSummary | null {
  const summaryRows = batchResults[batchResults.length - 1] as
    | readonly RunAggregateSummary[]
    | undefined;
  return summaryRows?.[0] ?? null;
}

/**
 * Read how many rows a non-`.returning()` statement changed, from its element in
 * a `db.batch` result. Drizzle passes a `run`-method statement's raw D1 result
 * straight through, so the element is a `D1Result` whose `meta.changes` is the
 * affected-row count (0 when a guarded `WHERE` matched nothing). Defaults to 0
 * for any shape that doesn't carry `meta.changes` — a missing count reads as
 * "nothing changed", the conservative answer for the no-op guard.
 *
 * This is the head-of-batch counterpart to `summaryFromBatchResults` (which owns
 * the tail-row cast): the single typed home for "did the guarded UPDATE flip a
 * row?", so `reconcileAndBroadcast` can suppress the follow-up broadcast on a
 * no-op finalize without each terminal path hand-poking at `meta.changes`.
 */
export function statementChangedRows(batchResult: unknown): number {
  const meta = (batchResult as { meta?: { changes?: number } } | undefined)
    ?.meta;
  return typeof meta?.changes === "number" ? meta.changes : 0;
}

/**
 * Run a heterogeneous write batch whose LAST statement produces the broadcast
 * summary, and return that transactionally-consistent summary (or `null` if the
 * final statement returned no row).
 *
 * Owns the convention used by `appendRunResults`: append the summary-producing
 * statement last, run them all in one D1 transaction (`db.batch`), then read back
 * the final result via `summaryFromBatchResults`. `summary` may be any
 * summary-producing statement — a `.returning()` UPDATE or a `.select()` — both
 * project `AGGREGATE_SUMMARY_COLUMNS`, so both yield `RunAggregateSummary[]`.
 * Concentrating the append-last + run + read-last positional contract here means
 * callers can't silently break the broadcast by inserting a trailing statement or
 * by counting array positions wrong.
 *
 * The terminal paths (`completeRun` / `finalizeStaleRun`) follow the same
 * append-summary-last convention but go through `reconcileAndBroadcast`, which
 * runs the batch directly so it can ALSO read the head element (the status flip's
 * `meta.changes`) to suppress a no-op finalize's broadcast — a read this
 * summary-only helper doesn't surface.
 *
 * The batch is `PromiseLike<unknown>[]` for the same reason as
 * `buildResultInsertStatements`: Drizzle's batch accepts a heterogeneous tuple
 * of query builders and expressing the union precisely fights the type system
 * more than it helps. The `db.batch` call-signature cast lives once in
 * `runBatch` (`@/lib/db-batch`), which this routes through.
 */
export async function runBatchWithSummary(
  writes: PromiseLike<unknown>[],
  summary: PromiseLike<unknown>,
): Promise<RunAggregateSummary | null> {
  const batchResults = await runBatch([...writes, summary]);
  return summaryFromBatchResults(batchResults);
}

/**
 * The terminal reconcile-and-broadcast tail shared by `completeRun` and
 * `finalizeStaleRun`: run the caller's status-flip UPDATE together with a single
 * `aggregateRecomputeStatement` (which projects the broadcast summary via its
 * `.returning()`) in one D1 batch, then broadcast that transactionally-consistent
 * summary to `run:<runId>` subscribers. The status-flip is FIRST and the
 * recompute is LAST, so `statementChangedRows(batchResults[0])` reads the flip's
 * affected-row count and `summaryFromBatchResults` reads the recompute's
 * `.returning()` row as the summary.
 *
 * Both terminal paths differ ONLY in the status-flip statement (completeRun
 * merges severity in SQL + max()'s duration/completedAt; finalizeStaleRun flips
 * to "interrupted" guarded on status="running"), so the caller passes that one
 * statement and the recompute scope; everything downstream of the write — append
 * recompute, batch, extract last row, broadcast-iff-present — lives here once
 * instead of being mirrored by convention across the two functions (and the
 * cron docstring). Returns the summary so callers can read back the merged
 * `status` (or ignore it).
 *
 * `requireStatusFlip` gates the broadcast on the status-flip UPDATE having
 * changed a row. `finalizeStaleRun`'s flip is guarded on status="running", so a
 * cron pass that overlaps another (or races a real /complete) finds the run
 * already off "running", matches 0 rows, and — with this set — stays silent
 * instead of emitting a redundant progress event. This is purely an efficiency
 * guard: the recompute is idempotent and its `.returning()` carries the row's
 * true (already-terminal) status, so the suppressed broadcast would have been
 * correct, just duplicate. completeRun's flip has no status guard (it always
 * matches the owned row), so it leaves this OFF and always broadcasts.
 *
 * Note `bumpTeamActivity` is deliberately NOT part of this tail: completeRun
 * bumps team activity (a user-driven /complete), finalizeStaleRun does not (a
 * cron sweep is not user activity). It stays at the caller.
 */
export async function reconcileAndBroadcast(
  runId: string,
  statusUpdate: PromiseLike<unknown>,
  recomputeScope: { projectId: string },
  opts?: { requireStatusFlip?: boolean },
): Promise<RunAggregateSummary | null> {
  const batchResults = await runBatch([
    statusUpdate,
    aggregateRecomputeStatement(recomputeScope, runId),
  ]);
  const summary = summaryFromBatchResults(batchResults);

  // A no-op finalize (guarded flip matched 0 rows) skips the second round-trip:
  // the run already left "running", so the broadcast would only duplicate the
  // terminal event a winning /complete or earlier sweep already sent.
  if (opts?.requireStatusFlip && statementChangedRows(batchResults[0]) === 0) {
    return summary;
  }
  if (summary) {
    await broadcastRunUpdate(runId, [], summary);
  }
  return summary;
}

/**
 * Bump `teams.lastActivityAt`. Awaited per the no-fire-and-forget rule —
 * workerd terminates orphaned promises after the response so an unawaited
 * write can be silently dropped.
 */
export async function bumpTeamActivity(
  teamId: string,
  nowSeconds: number,
): Promise<void> {
  await db
    .update(teams)
    .set({ lastActivityAt: nowSeconds })
    .where(eq(teams.id, teamId));
}

export function buildChangedTests(
  results: readonly TestResultInput[],
  assignedIds: Map<string, string>,
): RunProgressTest[] {
  return results.map((r) => ({
    id: assignedIds.get(r.testId)!,
    testId: r.testId,
    title: r.title,
    file: r.file,
    projectName: r.projectName ?? null,
    status: r.status,
    durationMs: r.durationMs,
    retryCount: r.retryCount,
    errorMessage: r.errorMessage ?? null,
    errorStack: r.errorStack ?? null,
  }));
}

/**
 * Publish a progress event to `run:<runId>` subscribers. Pure pub — the caller
 * is responsible for producing a `summary` that is transactionally consistent
 * with `changedTests` (typically via `.returning()` on the aggregate UPDATE in
 * the same batch, or the liveness-only `activityBumpStatement` when there's no
 * counter delta to apply).
 * Awaited because the publish RPC mustn't be dropped by workerd termination.
 */
export async function broadcastRunUpdate(
  runId: string,
  changedTests: RunProgressTest[],
  summary: RunAggregateSummary,
): Promise<void> {
  await publishRunUpdate(runId, {
    type: "progress",
    changedTests,
    summary,
  });
}

/**
 * Honor `payload.createdAt` / `payload.completedAt` overrides only in local
 * dev. The handlers' validators don't (and shouldn't) gate this — a stolen
 * production API key would otherwise be able to fabricate historical runs.
 *
 * `VITE_IS_DEV_SERVER` is wired by `vite.config.ts`; production builds inline
 * `false` here.
 */
export function backdatingAllowed(): boolean {
  return Boolean(import.meta.env?.VITE_IS_DEV_SERVER);
}

// ─── Run-scoped write operations ─────────────────────────────────────────────
//
// Three operations wrap the entire "verify ownership → compose batch → extract
// summary → bump team activity → broadcast" pipeline. Handlers call into these
// and translate the result to an HTTP response — no batch knowledge in routes.

export interface OpenRunResult {
  runId: string;
  duplicate: boolean;
}

/**
 * Open a streaming run. Idempotent on `(projectId, idempotencyKey)`: a second
 * call with the same key returns the existing runId without writing.
 *
 * On a fresh open, inserts the parent `runs` row plus any planned-test queue
 * rows in one batch, bumps `teams.lastActivityAt`, and broadcasts the
 * initial progress snapshot (synthesized inline — we just wrote the row,
 * no DB read needed).
 */
export async function openRun(
  scope: TenantScope,
  payload: OpenRunPayload,
  nowSeconds: number,
): Promise<OpenRunResult> {
  const existing = await db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.projectId, scope.projectId),
        eq(runs.idempotencyKey, payload.idempotencyKey),
      ),
    )
    .limit(1);
  if (existing[0]) {
    // Sharded suites share one idempotencyKey, so shards 2..N land here and
    // return the existing run without re-prefilling. We deliberately do NOT
    // prefill their planned tests as 'queued' rows: a prefilled row carries a
    // prev-status that suppresses the +totalTests delta when that shard's real
    // result streams in (computeAggregateDelta only bumps totalTests for a
    // genuinely new testId), which would pin totalTests at shard 1's count
    // mid-flight. Letting shards 2..N's results arrive as fresh rows keeps
    // totalTests climbing correctly; completeRun's recompute reconciles finals.
    // The serious sharding bug (a later passing shard overwriting an earlier
    // failure) is handled by completeRun's atomic monotonic status merge.
    return { runId: existing[0].id, duplicate: true };
  }

  const runId = ulid();
  const plannedTests = payload.run.plannedTests ?? [];

  const runInsert = db.insert(runs).values({
    id: runId,
    teamId: scope.teamId,
    projectId: scope.projectId,
    idempotencyKey: payload.idempotencyKey,
    ciProvider: payload.run.ciProvider ?? null,
    ciBuildId: payload.run.ciBuildId ?? null,
    branch: payload.run.branch ?? null,
    environment: payload.run.environment ?? null,
    commitSha: payload.run.commitSha ?? null,
    commitMessage: payload.run.commitMessage ?? null,
    prNumber: payload.run.prNumber ?? null,
    repo: payload.run.repo ?? null,
    actor: payload.run.actor ?? null,
    totalTests: plannedTests.length,
    expectedTotalTests: payload.run.expectedTotalTests ?? plannedTests.length,
    passed: 0,
    failed: 0,
    flaky: 0,
    skipped: 0,
    durationMs: 0,
    status: "running",
    reporterVersion: payload.run.reporterVersion ?? null,
    playwrightVersion: payload.run.playwrightVersion ?? null,
    createdAt: nowSeconds,
    // Seed the liveness signal at open so an onBegin-only dead run (one that
    // never streams a single /results) is still sweepable by `staleRunFilter`.
    lastActivityAt: nowSeconds,
    completedAt: null,
  });

  const stmts = [
    runInsert,
    ...buildQueuePrefillStatements(scope, runId, plannedTests, nowSeconds),
  ];
  if (stmts.length === 1) {
    await stmts[0];
  } else {
    // D1 batch atomicity: all-or-nothing.
    await runBatch(stmts);
  }
  await bumpTeamActivity(scope.teamId, nowSeconds);

  const summary: RunAggregateSummary = {
    totalTests: plannedTests.length,
    passed: 0,
    failed: 0,
    flaky: 0,
    skipped: 0,
    durationMs: 0,
    status: "running",
    completedAt: null,
  };
  await broadcastRunUpdate(runId, [], summary);

  return { runId, duplicate: false };
}

export type AppendRunResultsOutcome =
  | { kind: "ok"; mapping: ResultMapping[] }
  | { kind: "notFound" };

/**
 * Append a batch of test results to a streaming run. Verifies the run
 * belongs to `scope.projectId` (404 otherwise), then runs the upsert /
 * tag-replace / annotation-replace / per-attempt-insert / aggregate-delta
 * statements in one D1 batch. The last statement is `.returning()` on the
 * delta UPDATE (or a SELECT when no delta) so the broadcast summary is
 * transactionally consistent with the per-test writes.
 */
export async function appendRunResults(
  scope: TenantScope,
  runId: string,
  payload: AppendResultsPayload,
  nowSeconds: number,
): Promise<AppendRunResultsOutcome> {
  const owner = await db
    .select({ id: runs.id })
    .from(runs)
    .where(runByIdWhere(scope, runId))
    .limit(1);
  if (!owner[0]) return { kind: "notFound" };

  const testIds = payload.results.map((r) => r.testId);
  const { existingIds, assignedIds, prevStatusByTestId } =
    await resolveTestResultIds(scope, runId, testIds);
  const { statements, mapping } = buildResultInsertStatements(
    scope,
    runId,
    payload.results,
    nowSeconds,
    existingIds,
    assignedIds,
  );
  const deltaStmt = aggregateDeltaStatement(
    scope,
    runId,
    computeAggregateDelta(payload.results, prevStatusByTestId),
    nowSeconds,
  );
  // Both branches still advance `lastActivityAt`: the delta UPDATE sets it
  // alongside the counters; the no-delta branch is a liveness-only UPDATE
  // (not a read-only SELECT) so a zero-bucket-change flush still counts as
  // activity for `staleRunFilter`.
  const summaryStmt =
    deltaStmt ?? activityBumpStatement(scope, runId, nowSeconds);

  const summary = await runBatchWithSummary(statements, summaryStmt);
  await bumpTeamActivity(scope.teamId, nowSeconds);

  if (!summary) return { kind: "notFound" };

  const changedTests = buildChangedTests(payload.results, assignedIds);
  await broadcastRunUpdate(runId, changedTests, summary);

  return { kind: "ok", mapping };
}

export type CompleteRunOutcome =
  | { kind: "ok"; status: string }
  | { kind: "notFound" };

/**
 * Severity ranking for merging terminal run statuses across shards. A sharded
 * suite calls /complete once per shard against the SAME run (shared
 * idempotencyKey), and the shards can finish in any order. Without a merge the
 * last shard wins, so a run where one shard failed could be recorded "passed"
 * just because an all-passing shard happened to complete last. Higher = worse;
 * the worst outcome across shards is the run's outcome.
 */
const RUN_STATUS_SEVERITY: Record<string, number> = {
  skipped: 0,
  passed: 1,
  flaky: 2,
  interrupted: 3,
  timedout: 4,
  failed: 4,
};

/** Severity rank for a status not present in {@link RUN_STATUS_SEVERITY}. */
const UNKNOWN_STATUS_SEVERITY = 0;

/**
 * Severity rank of a run status, with unknown statuses pinned to
 * {@link UNKNOWN_STATUS_SEVERITY}. This single function owns the fallback so the
 * JS merge (`mergeRunStatus`) and the SQL merge (`statusSeveritySql`'s `else`)
 * cannot disagree about how an unrecognized status ranks — both derive it here.
 */
function runStatusSeverity(status: string): number {
  return RUN_STATUS_SEVERITY[status] ?? UNKNOWN_STATUS_SEVERITY;
}

/**
 * The monotonic status-merge invariant, in JS. It is the single source of the
 * decision the run's terminal status obeys across shards:
 *   1. a still-"running" run takes the incoming status verbatim;
 *   2. otherwise the incoming status wins only if STRICTLY more severe
 *      (`incoming > current`) — equally-severe statuses keep the current one,
 *      so arrival order can't flip-flop a terminal outcome.
 * `mergeRunStatusSql` encodes this exact rule as one atomic SQL `CASE`;
 * `merge-run-status.test.ts` exercises this reference, and the two are kept
 * branch-for-branch identical by hand (see `mergeRunStatusSql`).
 */
export function mergeRunStatus(current: string, incoming: string): string {
  if (current === "running") return incoming;
  return runStatusSeverity(incoming) > runStatusSeverity(current)
    ? incoming
    : current;
}

/**
 * SQL `CASE` mapping the current `runs.status` column to its severity rank,
 * built from the SAME `RUN_STATUS_SEVERITY` table and the same fallback
 * (`UNKNOWN_STATUS_SEVERITY`, the value `runStatusSeverity` returns for unknown
 * statuses) the JS reference uses, so the rank and the fallback are written
 * once, not transcribed.
 */
export function currentStatusSeveritySql() {
  let expr = sql`case ${runs.status}`;
  for (const [status, severity] of Object.entries(RUN_STATUS_SEVERITY)) {
    expr = sql`${expr} when ${status} then ${severity}`;
  }
  return sql`(${expr} else ${UNKNOWN_STATUS_SEVERITY} end)`;
}

/**
 * Atomic SQL form of `mergeRunStatus`: merges `incoming` into the current
 * `runs.status` column inside a single expression so `completeRun` reads and
 * writes `status` in one statement, closing the read-modify-write race that a
 * separate SELECT-then-UPDATE leaves open when two shards complete
 * concurrently.
 *
 * This is the production encoding of the decision documented on
 * `mergeRunStatus`; its branches are deliberately one-to-one with that
 * function — running-special-case, then a STRICT severity compare (`<`, so
 * ties keep the current status, matching JS's `inc > cur`) — and both consume
 * the same severity table. The pair is held in sync by hand: changing the
 * tie-break or the running case here MUST change `mergeRunStatus` too. The JS
 * reference is the tested surface; an executable assertion that binds this
 * UPDATE to it awaits the real-D1 harness (see docs).
 */
export function mergeRunStatusSql(incoming: string) {
  const incomingSeverity = runStatusSeverity(incoming);
  return sql`case when ${runs.status} = 'running' then ${incoming} when ${currentStatusSeveritySql()} < ${incomingSeverity} then ${incoming} else ${runs.status} end`;
}

/**
 * Finalize a streaming run. Verifies ownership, then in one batch sets the
 * terminal status / durationMs / completedAt and runs one aggregate
 * recompute to reconcile any straggler /results writes that raced this
 * call. Broadcasts the final summary.
 *
 * Sharding-safe: the terminal status is merged ATOMICALLY in SQL — a single
 * UPDATE keeps the more-severe outcome (a later all-passing shard can't
 * overwrite an earlier failure even if two shards' /complete calls overlap),
 * and durationMs/completedAt take the max across shards rather than last-write.
 */
export async function completeRun(
  scope: TenantScope,
  runId: string,
  payload: CompleteRunPayload,
  completedAt: number,
): Promise<CompleteRunOutcome> {
  const owner = await db
    .select({ id: runs.id })
    .from(runs)
    .where(runByIdWhere(scope, runId))
    .limit(1);
  if (!owner[0]) return { kind: "notFound" };

  // Monotonic status merge expressed entirely in SQL so the read (current
  // status) and write happen in one atomic statement — no TOCTOU window
  // between a SELECT and a separate UPDATE. The merge rule itself lives in one
  // place (`mergeRunStatusSql`, the SQL twin of `mergeRunStatus`).
  const statusExpr = mergeRunStatusSql(payload.status);

  const nowSeconds = Math.floor(Date.now() / 1000);
  const statusUpdate = db
    .update(runs)
    .set({
      status: statusExpr,
      durationMs: sql`max(${runs.durationMs}, ${payload.durationMs})`,
      completedAt: sql`max(coalesce(${runs.completedAt}, 0), ${completedAt})`,
      // /complete is an ingest write too — keep the liveness signal monotonic
      // so a late straggler /results racing this can't look stale to the
      // watchdog. Set in the same statement; no extra round-trip.
      lastActivityAt: nowSeconds,
    })
    .where(runByIdWhere(scope, runId));

  const summary = await reconcileAndBroadcast(runId, statusUpdate, scope);
  await bumpTeamActivity(scope.teamId, nowSeconds);

  return { kind: "ok", status: summary?.status ?? payload.status };
}

/**
 * Finalize a run the watchdog cron found stuck at status="running" past the
 * stale window (e.g. the CI job was SIGKILL'd and never called /complete).
 *
 * Mirrors `completeRun`'s reconcile-and-broadcast so an abandoned run lands on
 * accurate aggregates (recomputed from the testResults rows actually present —
 * not frozen at whatever the last /results delta left) AND live viewers receive
 * a terminal event instead of spinning on "running" forever. The status flip is
 * guarded on status="running" so it can't downgrade a run that completed
 * normally between the cron's scan and this write.
 *
 * `requireStatusFlip` makes a no-op finalize fully silent: when the guarded flip
 * matches 0 rows (an overlapping cron pass, or a /complete that won the race),
 * the redundant terminal broadcast is suppressed. The DB stays correct either
 * way — this just spares the duplicate live event + its round-trip.
 *
 * `run` ids come from a trusted DB row (not user input), so no Authorized* brand
 * is required here — the recompute is keyed by the run's own projectId.
 */
export async function finalizeStaleRun(
  run: { id: string; projectId: string; teamId: string },
  completedAt: number,
): Promise<void> {
  const statusUpdate = db
    .update(runs)
    .set({ status: "interrupted", completedAt, lastActivityAt: completedAt })
    .where(
      and(
        eq(runs.projectId, run.projectId),
        eq(runs.id, run.id),
        eq(runs.status, "running"),
      ),
    );

  await reconcileAndBroadcast(
    run.id,
    statusUpdate,
    { projectId: run.projectId },
    { requireStatusFlip: true },
  );
}

/** Counts a watchdog sweep emits: rows seen, finalized, and failed. */
export interface SweepStaleRunsResult {
  found: number;
  finalized: number;
  failed: number;
}

/**
 * Max stale runs finalized concurrently within a sweep pass. `.limit` caps the
 * TOTAL subrequests per invocation (limit × ~2); this caps how many of those are
 * in flight at once so we don't open the whole slice's worth of D1/RPC
 * connections simultaneously. Small constant — parallel enough to keep wall-time
 * down, conservative enough to stay friendly to the runtime's connection limits.
 */
const STALE_RUN_FINALIZE_CONCURRENCY = 10;

/**
 * Drain a batch of stale runs through `finalize` with bounded concurrency and
 * partial-failure tolerance, tallying the outcome.
 *
 * This is the watchdog's budget policy as a PURE orchestrator: it takes the
 * already-selected rows and the per-run finalizer as parameters, so it never
 * touches D1 itself and is unit-testable against a fake finalizer. The D1 SELECT
 * (with its `.limit`) lives in `sweepStaleRuns` above it.
 *
 * Why chunked `Promise.allSettled` rather than the old strict-serial loop: each
 * `finalize` is ~2 serial round-trips (a `db.batch` recompute + a `void/live`
 * broadcast), so draining an unbounded backlog one run at a time inside a single
 * scheduled invocation is exactly how the watchdog self-DoSes under its design
 * load — the Workers subrequest/CPU budget runs out mid-drain and the invocation
 * is killed. Running each chunk concurrently keeps wall-time bounded; `allSettled`
 * means one stuck run's failure never aborts the pass (the survivors still flip,
 * drop out of the next SELECT, and the backlog keeps shrinking).
 *
 * `chunkSize` goes through the same `chunkBySize` slicer the D1 param-cap
 * chunker uses, so the fixed-size chunking lives in one place; here it bounds
 * in-flight finalizations per `allSettled` wave rather than D1 params-per-statement.
 */
export async function drainStaleRuns<T extends { id: string }>(
  staleRuns: T[],
  finalize: (run: T) => Promise<void>,
  opts: { chunkSize: number; onError?: (run: T, err: unknown) => void },
): Promise<SweepStaleRunsResult> {
  let finalized = 0;
  let failed = 0;

  for (const chunk of chunkBySize(staleRuns, opts.chunkSize)) {
    const settled = await Promise.allSettled(chunk.map((run) => finalize(run)));
    settled.forEach((result, i) => {
      if (result.status === "fulfilled") {
        finalized++;
      } else {
        failed++;
        opts.onError?.(chunk[i]!, result.reason);
      }
    });
  }

  return { found: staleRuns.length, finalized, failed };
}

/**
 * Watchdog entry point: select at most `limit` runs the `staleRunFilter` deems
 * stuck and finalize them with bounded concurrency, returning the pass's tally.
 *
 * The `.limit(limit)` is the load-bearing budget: each invocation drains a capped
 * slice so the cron makes guaranteed forward progress and stays well under the
 * Workers subrequest/CPU budget even when a mass-stranding event has left a huge
 * backlog at status='running'. Finalized runs flip to 'interrupted' (the UPDATE
 * is guarded on status='running' in `finalizeStaleRun`), so they drop out of the
 * next pass's SELECT and the backlog drains incrementally across invocations.
 *
 * One tidy home for the limit + concurrency + counting policy: the cron is a thin
 * adapter that maps env config in and logs the tally out.
 */
export async function sweepStaleRuns(opts: {
  cutoffSeconds: number;
  limit: number;
  now: number;
}): Promise<SweepStaleRunsResult> {
  const stale = await db
    .select({ id: runs.id, projectId: runs.projectId, teamId: runs.teamId })
    .from(runs)
    .where(staleRunFilter(opts.cutoffSeconds))
    .limit(opts.limit);

  return drainStaleRuns(stale, (run) => finalizeStaleRun(run, opts.now), {
    chunkSize: STALE_RUN_FINALIZE_CONCURRENCY,
    onError: (run, err) => {
      logger.error("failed to finalize stale run", {
        runId: run.id,
        projectId: run.projectId,
        message: err instanceof Error ? err.message : String(err),
      });
    },
  });
}
