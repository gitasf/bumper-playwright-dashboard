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
import type { BatchExecutor } from "@/lib/db-batch";
import { changedRows, isUniqueViolation, runBatch } from "@/lib/db-batch";
import { maybePostGithubCheck } from "@/lib/github-checks";
import { setCodeownersFile } from "@/lib/owners-repo";
import {
  childByIdWhere,
  childByTestResultWhere,
  childProjectScopeWhere,
  runByIdWhere,
  staleRunFilter,
  type TenantScope,
} from "@/lib/scope";
import { monthStartSeconds, usageBumpStatement } from "@/lib/usage";
import { broadcastProjectRoom, broadcastRunRoom } from "@/realtime/publish";
import type {
  AppendResultsPayload,
  CompleteRunPayload,
  OpenRunPayload,
  TestResultInput,
} from "@/lib/schemas";
import type {
  ProjectFeedEvent,
  RunProgressEvent,
  RunProgressTest,
} from "@/realtime/events";

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
 * logical tenant isolation, and `runBatch` (a Postgres `db.transaction`) is the
 * atomicity boundary. Realtime broadcasts go through the `void/ws` rooms — the
 * run room (`run:<runId>`) and the project room (`project:<projectId>`) — via
 * `@/realtime/publish` (ADR 0001).
 *
 * See `docs/worklog/void-migration-consolidated.md` for the architecture
 * decisions behind the single-database model.
 */

// Postgres per-statement bound-parameter ceiling (65535). Drives multi-row-insert
// chunk size: each statement in a `db.transaction` is its own round-trip, so the
// large ceiling keeps a big flush to a couple of statements (~4600 rows each)
// rather than hundreds of round-trips.
export const PG_MAX_BOUND_PARAMS = 65_535;

/**
 * Slice `items` into consecutive sub-arrays of at most `size` (always ≥1, so a
 * pathological `size <= 0` still makes progress one item at a time rather than
 * looping forever). The single home for fixed-size chunking — both the
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
 * under Postgres's per-statement parameter ceiling, given the number of columns
 * each row binds. Hides the `Math.floor(maxParams / columnsPerRow)` arithmetic
 * behind one call so the cap lives in exactly one place.
 *
 * Prefer `chunkInsertRows` for real inserts — it derives `columnsPerRow` from
 * the row shape so the count can't drift from the row literal. This lower-level
 * form is kept for the unit test that asserts the chunking math directly.
 */
export function chunkByParams<T>(
  rows: T[],
  columnsPerRow: number,
  maxParams: number = PG_MAX_BOUND_PARAMS,
): T[][] {
  return chunkBySize(rows, Math.floor(maxParams / columnsPerRow));
}

/**
 * Chunk insert rows for a multi-row `db.insert(table).values(chunk)`, deriving
 * the per-row column count from the row object itself (`Object.keys(row).length`)
 * — the SAME object that is handed to `.values()`. There is therefore no
 * separate hand-counted column constant that can silently drift from the row
 * shape when a column is added (the classic footgun: a nullable column makes
 * `$inferInsert` optional, so it lands in the row literal with no compile
 * error, and a stale literal count would then pack rows past Postgres's
 * per-statement bound-param ceiling and the statement would be rejected at
 * runtime).
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
  // One SELECT for the whole batch: a /results batch is hard-capped at
  // MAX_RESULTS_PER_BATCH (5000) and `dedupeResultsByTestId` only shrinks it, so
  // `testIds` is always well under Postgres's per-statement bound-param ceiling
  // — no IN-list chunking is needed.
  const rows = await db
    .select({
      id: testResults.id,
      testId: testResults.testId,
      status: testResults.status,
    })
    .from(testResults)
    .where(
      and(
        childProjectScopeWhere(testResults.projectId, scope),
        eq(testResults.runId, runId),
        inArray(testResults.testId, testIds),
      ),
    );
  for (const row of rows) {
    existingIds.set(row.testId, row.id);
    prevStatusByTestId.set(row.testId, row.status);
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
  exec: BatchExecutor,
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
    exec.insert(testResults).values(chunk).onConflictDoNothing(),
  );
}

/**
 * Builds the upsert-and-replace statements for a /results batch. Returns the
 * statement array (built against the transaction executor `tx` for `runBatch`)
 * plus the clientKey→id map the reporter uses to fire per-test artifact uploads.
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
  exec: BatchExecutor,
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
        exec
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
          .where(childByIdWhere(testResults, scope, testResultId)),
      );
      statements.push(
        exec
          .delete(testTags)
          .where(childByTestResultWhere(testTags, scope, testResultId)),
      );
      statements.push(
        exec
          .delete(testAnnotations)
          .where(childByTestResultWhere(testAnnotations, scope, testResultId)),
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
      exec
        .delete(testResultAttempts)
        .where(childByTestResultWhere(testResultAttempts, scope, testResultId)),
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
    statements.push(exec.insert(testResults).values(chunk));
  }
  for (const chunk of chunkInsertRows(tagRows)) {
    statements.push(exec.insert(testTags).values(chunk));
  }
  for (const chunk of chunkInsertRows(annotationRows)) {
    statements.push(exec.insert(testAnnotations).values(chunk));
  }
  for (const chunk of chunkInsertRows(attemptRows)) {
    statements.push(exec.insert(testResultAttempts).values(chunk));
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
 *
 * Sibling table: the UI's presentation collapse (`STATUS`/`statusGroupKey` in
 * `@/lib/status`) encodes the same `timedout → failed` rule plus an
 * `interrupted → flaky` entry. The omission of `interrupted` HERE is
 * deliberate, not drift: the wire schema's per-test status enum never carries
 * it (the reporter normalises interrupted attempts to `skipped`), so it can
 * only appear as a run-level terminal status — which these per-test aggregate
 * buckets never see. Keep the two tables' shared rows in sync when editing.
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
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- Object.entries erases literal key types; `bucket` is provably a key of STATUS_BUCKET_MEMBERS
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
  exec: BatchExecutor,
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
  return exec
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
  exec: BatchExecutor,
) {
  return exec
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
  exec: BatchExecutor,
) {
  const projectId = scope.projectId;
  const bucketCount = (statuses: readonly string[]) =>
    sql`(SELECT COUNT(*) FROM "testResults" WHERE "projectId" = ${projectId} AND "runId" = ${runId} AND ${statusMatchSql(statuses)})`;
  return exec
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
 * Extract the publishable summary from a transaction's statement results, given
 * the invariant that the summary-producing statement (an
 * `AGGREGATE_SUMMARY_COLUMNS` `.returning()` UPDATE) was run LAST. `runBatch`
 * returns one result array per statement in order, so the summary row is the
 * first element of the final result.
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
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- transaction statement results are `unknown[]`; the tail statement's `.returning()` shape is the documented contract (single typed home, see fn doc)
  const summaryRows = batchResults[batchResults.length - 1] as
    | readonly RunAggregateSummary[]
    | undefined;
  return summaryRows?.[0] ?? null;
}

/**
 * Read how many rows a non-`.returning()` statement changed, from its element in
 * a transaction result. The dialect-specific shape (node-postgres `rowCount` in
 * prod, pglite `affectedRows` on the test lane) is owned by `changedRows`
 * (`@/lib/db-batch`); this is the run-scoped alias kept so `reconcileAndBroadcast`
 * reads "did the guarded UPDATE flip a row?" through a name local to the ingest
 * pipeline (the head-of-batch counterpart to `summaryFromBatchResults`).
 */
export const statementChangedRows = changedRows;

/**
 * Run a heterogeneous write batch whose LAST statement produces the broadcast
 * summary, and return that transactionally-consistent summary (or `null` if the
 * final statement returned no row).
 *
 * Owns the convention used by `appendRunResults`: append the summary-producing
 * statement last, run them all in one Postgres transaction (`runBatch`), then read
 * back the final result via `summaryFromBatchResults`. `summary` may be any
 * summary-producing statement — a `.returning()` UPDATE or a `.select()` — both
 * project `AGGREGATE_SUMMARY_COLUMNS`, so both yield `RunAggregateSummary[]`.
 * Concentrating the append-last + run + read-last positional contract here means
 * callers can't silently break the broadcast by inserting a trailing statement or
 * by counting array positions wrong.
 *
 * The terminal paths (`completeRun` / `finalizeStaleRun`) follow the same
 * append-summary-last convention but go through `reconcileAndBroadcast`, which
 * runs the transaction directly so it can ALSO read the head element (the status
 * flip's affected-row count) to suppress a no-op finalize's broadcast — a read
 * this summary-only helper doesn't surface.
 *
 * The batch is `PromiseLike<unknown>[]` for the same reason as
 * `buildResultInsertStatements`: a transaction runs a heterogeneous tuple of
 * query builders and expressing the union precisely fights the type system more
 * than it helps. `runBatch` (`@/lib/db-batch`), which this routes through, builds
 * every statement against the transaction executor (`tx`) — no cast — so the
 * statements enroll in the transaction.
 */
export async function runBatchWithSummary(
  build: (exec: BatchExecutor) => {
    writes: PromiseLike<unknown>[];
    summary: PromiseLike<unknown>;
  },
): Promise<RunAggregateSummary | null> {
  const batchResults = await runBatch((tx) => {
    const { writes, summary } = build(tx);
    return [...writes, summary];
  });
  return summaryFromBatchResults(batchResults);
}

/**
 * The terminal reconcile-and-broadcast tail shared by `completeRun` and
 * `finalizeStaleRun`: run the caller's status-flip UPDATE together with a single
 * `aggregateRecomputeStatement` (which projects the broadcast summary via its
 * `.returning()`) in one transaction, then broadcast that transactionally-consistent
 * summary to `run:<runId>` subscribers. The status-flip is FIRST and the
 * recompute is LAST, so `statementChangedRows(batchResults[0])` reads the flip's
 * affected-row count and `summaryFromBatchResults` reads the recompute's
 * `.returning()` row as the summary.
 *
 * Both terminal paths differ ONLY in the status-flip statement (completeRun
 * merges severity in SQL + greatest()'s duration/completedAt; finalizeStaleRun flips
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
  buildStatusUpdate: (exec: BatchExecutor) => PromiseLike<unknown>,
  recomputeScope: { projectId: string },
  opts?: { requireStatusFlip?: boolean },
): Promise<RunAggregateSummary | null> {
  const batchResults = await runBatch((tx) => [
    buildStatusUpdate(tx),
    aggregateRecomputeStatement(recomputeScope, runId, tx),
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
    // Flip the run's row to its terminal status on any open runs list.
    // Synthetic runs broadcast too — the feed's origin policy is client-side.
    const event: ProjectFeedEvent = { type: "run-progress", runId, summary };
    await broadcastProjectRoom(recomputeScope.projectId, event);
  }
  return summary;
}

/**
 * Whether an open-run payload's `codeowners` field should update the project's
 * stored CODEOWNERS file. PURE — unit-testable. The reporter sends the field
 * only when it found a CODEOWNERS on disk; an absent OR empty/whitespace-only
 * value must NOT clobber a file an owner pasted manually in settings (the only
 * way to clear it is the settings textarea). So we update iff the payload
 * carries non-blank content.
 */
export function shouldUpdateCodeowners(
  codeowners: string | undefined,
): codeowners is string {
  return typeof codeowners === "string" && codeowners.trim().length > 0;
}

/**
 * Upsert the project's CODEOWNERS file from an open-run payload, when present
 * (roadmap 2.3). The ingest adapter for `setCodeownersFile`: it owns only the
 * PRESENCE policy — the reporter sends the field only when it found a CODEOWNERS
 * on disk, and an absent OR empty/whitespace-only value must NOT clobber a file
 * an owner pasted manually in settings (the only way to clear it is the settings
 * textarea). So we forward to the seam iff the payload carries non-blank content.
 *
 * The trim-then-normalize and unchanged-guard (skip the write AND the
 * `codeownersUpdatedAt` bump for a stable repo file) live in `setCodeownersFile`.
 * Awaited per the no-fire-and-forget rule. Best-effort: a failure is logged but
 * never fails the run open (a missing CODEOWNERS just leaves ownership
 * derivation on the previous file).
 */
export async function maybeUpdateCodeowners(
  scope: TenantScope,
  codeowners: string | undefined,
  nowSeconds: number,
): Promise<void> {
  if (!shouldUpdateCodeowners(codeowners)) return;
  try {
    await setCodeownersFile(scope, codeowners, nowSeconds);
  } catch (err) {
    logger.error("update codeowners from ingest failed", {
      projectId: scope.projectId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
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
  const event: RunProgressEvent = { type: "progress", changedTests, summary };
  // Single point — every run broadcast (open / append / complete-reconcile)
  // flows through here to the WS run room (the run-detail page).
  await broadcastRunRoom(runId, event);
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
 * Build the `runs` row for an open. PURE — the single place the run-row shape is
 * derived from the open payload, so the field mapping is unit-testable without a
 * live D1 (the `db.insert` call site can't run under the vitest harness). The
 * synthetic-monitoring provenance (`origin` / `monitorId`) lives here too: it
 * was silently dropped before — the validator accepted both on `payload.run` and
 * the reporter/stub sent them, but this row never copied them, so every
 * synthetic run persisted as `origin = 'ci'` (the column default) with a null
 * `monitorId`, leaving the provenance columns + their index inert. The
 * `runs.$inferInsert` return type keeps the shape honest for REQUIRED columns —
 * but note `origin` (has a `.default()`) and `monitorId` (nullable) are OPTIONAL
 * in `$inferInsert`, so re-dropping THOSE two lines would NOT be a type error.
 * Their regression guard is the unit test (`build-run-insert-values.test.ts`),
 * which asserts the persisted values directly.
 */
export function buildRunInsertValues(
  runId: string,
  scope: TenantScope,
  payload: OpenRunPayload,
  nowSeconds: number,
): typeof runs.$inferInsert {
  const plannedTests = payload.run.plannedTests ?? [];
  return {
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
    // Synthetic-monitoring provenance. Absent → 'ci'/null (the column defaults),
    // so a normal CI reporter run is unchanged; a synthetic run is tagged
    // `origin = 'synthetic'` + carries its `monitorId` so the runs list/insights
    // can separate synthetic traffic and `runs_project_monitor_created_at_idx`
    // resolves "runs for this monitor".
    origin: payload.run.origin ?? "ci",
    monitorId: payload.run.monitorId ?? null,
    createdAt: nowSeconds,
    // Seed the liveness signal at open so an onBegin-only dead run (one that
    // never streams a single /results) is still sweepable by `staleRunFilter`.
    lastActivityAt: nowSeconds,
    completedAt: null,
  };
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
  // Refresh the project's CODEOWNERS from the reporter's on-disk copy when it
  // sent one (roadmap 2.3). Runs on both the fresh-open and duplicate (CI
  // re-run / late shard) paths so an updated repo file is always picked up;
  // a no-op when the payload omits it, so a manually-pasted file is preserved.
  await maybeUpdateCodeowners(scope, payload.codeowners, nowSeconds);

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
    await reopenRunForWrites(scope, existing[0].id, nowSeconds);
    return { runId: existing[0].id, duplicate: true };
  }

  const runId = ulid();
  const plannedTests = payload.run.plannedTests ?? [];

  const runValues = buildRunInsertValues(runId, scope, payload, nowSeconds);
  try {
    // All-or-nothing: the run insert, the queued-test prefill, and the usage
    // meter bump (run open) commit atomically in one `db.transaction` (see
    // `runBatch`). Every statement is built against the passed executor so it
    // enrolls in that boundary.
    await runBatch((tx) => {
      const usageBump = usageBumpStatement(
        scope.teamId,
        monthStartSeconds(nowSeconds),
        { runs: 1 },
        nowSeconds,
        tx,
      );
      return [
        tx.insert(runs).values(runValues),
        ...buildQueuePrefillStatements(
          scope,
          runId,
          plannedTests,
          nowSeconds,
          tx,
        ),
        ...(usageBump ? [usageBump] : []),
      ];
    });
  } catch (err) {
    // Lost the SELECT-then-INSERT race: sharded suites share one
    // idempotencyKey and open concurrently BY DESIGN, so the loser's insert
    // hitting `runs_project_idempotency_key_idx` is the expected hot path, not
    // a corner. Recover by re-reading the winner's row instead of bubbling a
    // 500 the reporter would have to absorb via retry.
    if (!isUniqueViolation(err)) throw err;
    const winner = await db
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          eq(runs.projectId, scope.projectId),
          eq(runs.idempotencyKey, payload.idempotencyKey),
        ),
      )
      .limit(1);
    if (!winner[0]) throw err;
    await reopenRunForWrites(scope, winner[0].id, nowSeconds);
    return { runId: winner[0].id, duplicate: true };
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

  // Tell the runs list a brand-new run exists so it can prepend the row live
  // (the run-room broadcast above only reaches the run-detail page; a viewer on
  // the list isn't subscribed to a run that didn't exist at load). Synthetic
  // runs are broadcast too — the event carries `origin` and the CLIENT decides
  // per active view (the runs list's origin filter), so the Monitors/All views
  // stay live instead of freezing at their SSR state.
  const createdEvent: ProjectFeedEvent = {
    type: "run-created",
    run: {
      id: runId,
      origin: payload.run.origin ?? "ci",
      status: "running",
      passed: 0,
      failed: 0,
      flaky: 0,
      skipped: 0,
      totalTests: plannedTests.length,
      durationMs: 0,
      completedAt: null,
      createdAt: nowSeconds,
      branch: payload.run.branch ?? null,
      prNumber: payload.run.prNumber ?? null,
      commitSha: payload.run.commitSha ?? null,
      commitMessage: payload.run.commitMessage ?? null,
      environment: payload.run.environment ?? null,
      actor: payload.run.actor ?? null,
      ciProvider: payload.run.ciProvider ?? null,
      repo: payload.run.repo ?? null,
    },
  };
  await broadcastProjectRoom(scope.projectId, createdEvent);

  return { runId, duplicate: false };
}

export type AppendRunResultsOutcome =
  | { kind: "ok"; mapping: ResultMapping[] }
  | { kind: "notFound" }
  | { kind: "runClosed" };

/**
 * How long a terminal run keeps accepting ingest writes after its LAST write
 * activity. Without ANY bound, a compromised API key could silently rewrite
 * months-old runs; with a `completedAt`-only bound, every legitimate re-stream
 * broke (CI job re-runs share their idempotency key BY DESIGN, unbalanced
 * shards stream past a sibling's /complete, seeders re-open fixed-key runs).
 *
 * The window is therefore keyed on activity, and `openRun`'s duplicate path
 * RE-ARMS it (see `reopenRunForWrites`): every legitimate flow starts with an
 * open — which requires knowing the run's idempotency key, a value that never
 * appears in URLs or PR comments — while a stolen runId alone (those DO leak
 * into URLs) cannot reopen an idle terminal run. Accepted writes keep sliding
 * the window via `lastActivityAt`, so long-running suites are unaffected.
 * 30 minutes matches the stale-run watchdog's default.
 */
export const RUN_WRITE_GRACE_SECONDS = 30 * 60;

/**
 * Whether an ingest write (/results, /complete, /artifacts/register, artifact
 * upload) should be refused because the run is terminal AND idle past the
 * grace window. PURE — unit-tested directly; callers feed it the owner-probe
 * row. A still-`running` run is never closed (the stale-run watchdog owns
 * abandoned ones).
 */
export function runClosedForWrites(
  run: {
    status: string;
    completedAt: number | null;
    lastActivityAt: number | null;
  },
  nowSeconds: number,
): boolean {
  if (run.status === "running") return false;
  if (run.completedAt === null) return false;
  const lastWrite = Math.max(run.completedAt, run.lastActivityAt ?? 0);
  return nowSeconds - lastWrite > RUN_WRITE_GRACE_SECONDS;
}

/** The owner-probe columns every closure-guarded ingest write reads. */
export const RUN_WRITE_GUARD_COLUMNS = {
  id: runs.id,
  status: runs.status,
  completedAt: runs.completedAt,
  lastActivityAt: runs.lastActivityAt,
} as const;

/**
 * Re-arm a terminal run's write window from `openRun`'s duplicate path: a
 * caller presenting the run's idempotency key is a legitimate re-stream (CI
 * re-run, late shard, seeder), so its appends/completes must not 409 against
 * the idle-run closure guard. Bumping `lastActivityAt` is sufficient —
 * `runClosedForWrites` keys on it.
 */
async function reopenRunForWrites(
  scope: TenantScope,
  runId: string,
  nowSeconds: number,
): Promise<void> {
  await db
    .update(runs)
    .set({ lastActivityAt: nowSeconds })
    .where(runByIdWhere(scope, runId));
}

/**
 * Last-write-wins dedupe of a /results payload by `testId`. Two entries with
 * one (new) testId would otherwise share a single assigned ULID and the
 * multi-row insert would hit the testResults PK — failing the whole batch
 * with a 500 for what is a reporter-side bug. Zod doesn't enforce uniqueness,
 * so totality lives here. Order keeps each testId's first position; content
 * is the last occurrence (matching the row the UPDATE path would have left).
 */
export function dedupeResultsByTestId(
  results: TestResultInput[],
): TestResultInput[] {
  if (results.length < 2) return results;
  const byTestId = new Map<string, TestResultInput>();
  for (const result of results) {
    byTestId.set(result.testId, result);
  }
  if (byTestId.size === results.length) return results;
  return [...byTestId.values()];
}

/**
 * Append a batch of test results to a streaming run. Verifies the run
 * belongs to `scope.projectId` (404 otherwise), then runs the upsert /
 * tag-replace / annotation-replace / per-attempt-insert / aggregate-delta
 * statements in one transaction. The last statement is `.returning()` on the
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
    .select(RUN_WRITE_GUARD_COLUMNS)
    .from(runs)
    .where(runByIdWhere(scope, runId))
    .limit(1);
  if (!owner[0]) return { kind: "notFound" };
  if (runClosedForWrites(owner[0], nowSeconds)) return { kind: "runClosed" };

  const results = dedupeResultsByTestId(payload.results);
  const testIds = results.map((r) => r.testId);
  const { existingIds, assignedIds, prevStatusByTestId } =
    await resolveTestResultIds(scope, runId, testIds);
  // Meter FRESH testResults rows only (testIds not already present on this run),
  // so a re-streamed/retried flush doesn't double-count. Joins the same batch.
  const freshResultCount = results.reduce(
    (n, r) => (existingIds.has(r.testId) ? n : n + 1),
    0,
  );
  const delta = computeAggregateDelta(results, prevStatusByTestId);
  // The clientKey→testResultId map is produced while building the statements;
  // capture it from inside the batch builder for the post-batch artifact step.
  // runBatch invokes the builder synchronously at the head of the awaited
  // transaction, so `mapping` is populated before this await resolves.
  let mapping: ResultMapping[] = [];
  // One atomic write: the per-test upsert/replace statements, the usage meter
  // bump, and the summary-producing statement (LAST), built against the
  // transaction executor so they enroll in the same `db.transaction`.
  const summary = await runBatchWithSummary((tx) => {
    const built = buildResultInsertStatements(
      scope,
      runId,
      results,
      nowSeconds,
      existingIds,
      assignedIds,
      tx,
    );
    mapping = built.mapping;
    const usageBump = usageBumpStatement(
      scope.teamId,
      monthStartSeconds(nowSeconds),
      { testResults: freshResultCount },
      nowSeconds,
      tx,
    );
    // Both summary branches still advance `lastActivityAt`: the delta UPDATE
    // sets it alongside the counters; the no-delta branch is a liveness-only
    // UPDATE (not a read-only SELECT) so a zero-bucket-change flush still
    // counts as activity for `staleRunFilter`.
    const summaryStmt =
      aggregateDeltaStatement(scope, runId, delta, nowSeconds, tx) ??
      activityBumpStatement(scope, runId, nowSeconds, tx);
    return {
      writes: usageBump ? [...built.statements, usageBump] : built.statements,
      summary: summaryStmt,
    };
  });
  // `bumpTeamActivity` runs only after the notFound guard below (origin/main's
  // review fix): a write that found no run must not record team activity.
  if (!summary) return { kind: "notFound" };

  await bumpTeamActivity(scope.teamId, nowSeconds);

  const changedTests = buildChangedTests(results, assignedIds);
  await broadcastRunUpdate(runId, changedTests, summary);
  // Advance the run's row on any open runs list (project-wide feed). Synthetic
  // runs broadcast too — the feed's origin policy lives client-side, where the
  // active view is known (run-created events carry `origin`; progress events
  // merge by id into rows the view already holds).
  const progressEvent: ProjectFeedEvent = {
    type: "run-progress",
    runId,
    summary,
  };
  await broadcastProjectRoom(scope.projectId, progressEvent);

  return { kind: "ok", mapping };
}

export type CompleteRunOutcome =
  | { kind: "ok"; status: string }
  | { kind: "notFound" }
  | { kind: "runClosed" };

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
  const nowSeconds = Math.floor(Date.now() / 1000);
  const owner = await db
    .select(RUN_WRITE_GUARD_COLUMNS)
    .from(runs)
    .where(runByIdWhere(scope, runId))
    .limit(1);
  if (!owner[0]) return { kind: "notFound" };
  // Same closure policy as /results: a terminal run idle past the grace
  // window refuses /complete too — without this, a compromised key could
  // still escalate a months-old passed run to failed via the severity merge.
  // Legitimate duplicate/raced completes land within the window (the first
  // complete just bumped lastActivityAt), and re-runs re-arm it via openRun.
  if (runClosedForWrites(owner[0], nowSeconds)) return { kind: "runClosed" };

  // Monotonic status merge expressed entirely in SQL so the read (current
  // status) and write happen in one atomic statement — no TOCTOU window
  // between a SELECT and a separate UPDATE. The merge rule itself lives in one
  // place (`mergeRunStatusSql`, the SQL twin of `mergeRunStatus`).
  const statusExpr = mergeRunStatusSql(payload.status);
  const summary = await reconcileAndBroadcast(
    runId,
    (tx) =>
      tx
        .update(runs)
        .set({
          status: statusExpr,
          // Postgres `max` is an aggregate; the scalar "larger of two" is
          // `greatest` (SQLite's 2-arg `max` does not exist here).
          durationMs: sql`greatest(${runs.durationMs}, ${payload.durationMs})`,
          completedAt: sql`greatest(coalesce(${runs.completedAt}, 0), ${completedAt})`,
          // /complete is an ingest write too — keep the liveness signal
          // monotonic so a late straggler /results racing this can't look
          // stale to the watchdog. Set in the same statement; no extra
          // round-trip.
          lastActivityAt: nowSeconds,
        })
        .where(runByIdWhere(scope, runId)),
    scope,
  );
  await bumpTeamActivity(scope.teamId, nowSeconds);
  // Best-effort GitHub check run (no-op unless the App is configured + the
  // repo's org installed it). Awaited per the no-fire-and-forget rule; it
  // swallows its own errors so a GitHub outage never fails /complete.
  await maybePostGithubCheck(runId);

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
  await reconcileAndBroadcast(
    run.id,
    (tx) =>
      tx
        .update(runs)
        .set({
          status: "interrupted",
          completedAt,
          lastActivityAt: completedAt,
        })
        .where(
          and(
            eq(runs.projectId, run.projectId),
            eq(runs.id, run.id),
            eq(runs.status, "running"),
          ),
        ),
    { projectId: run.projectId },
    { requireStatusFlip: true },
  );
  // Watchdog-finalized runs (CI killed before /complete) still post their check
  // — same best-effort, self-silencing path as completeRun.
  await maybePostGithubCheck(run.id);
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
 * `finalize` is ~2 serial round-trips (a `db.batch` recompute + a `void/ws` room
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
