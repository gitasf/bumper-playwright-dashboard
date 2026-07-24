import { ulid } from "ulid";
import { and, db, eq, inArray, sql } from "void/db";
import { env } from "void/env";
import { logger } from "void/log";
import {
  runs,
  runShards,
  testAnnotations,
  testResultAttempts,
  testResults,
  tests,
  testTags,
  teams,
} from "@schema";
import type { BatchExecutor } from "@/lib/db/batch";
import {
  changedRows,
  isForeignKeyViolation,
  isUniqueViolation,
  runBatch,
} from "@/lib/db/batch";
import { postGithubRunSurfaces } from "@/lib/github-run-surfaces";
import { setCodeownersFile } from "@/lib/owners-repo";
import {
  childByTestResultsWhere,
  childProjectScopeWhere,
  runByIdWhere,
  staleRunFilter,
  type TenantScope,
} from "@/lib/scope";
import { STATUS_BUCKETS, WIRE_INVISIBLE_STATUSES } from "@/lib/status-buckets";
import {
  monthStartSeconds,
  usageBumpStatement,
  usageGuardedBumpStatement,
} from "@/lib/usage";
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
  expectedTotalTests: runs.expectedTotalTests,
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

async function resolveTestResultIds(
  scope: TenantScope,
  runId: string,
  testIds: string[],
  // The executor the read runs on. Defaults to the pooled `db`, but
  // `appendRunResults` passes its transaction executor so the prev-status read
  // happens UNDER the run-row `FOR UPDATE` lock — that is what makes the
  // additive aggregate delta race-safe (see `appendRunResults`).
  exec: Pick<typeof db, "select"> = db,
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
  const rows = await exec
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

function buildQueuePrefillStatements(
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
  shardIndex: number | null = null,
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
    // The opening shard stamps its planned (still-queued) rows with its own
    // index so they group by shard before they run; each shard's real result
    // arrives with its own shardIndex via /results. Null on a non-sharded run.
    shardIndex,
    createdAt: nowSeconds,
    updatedAt: nowSeconds,
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
 * Upsert the per-project `tests` catalog (the identity/dimension table) for a
 * set of `{ testId, title, file }` seen in this batch. Built against the passed
 * executor so it enrolls in the caller's ingest transaction — the catalog row is
 * written atomically with the results it describes, from BOTH the openRun queued
 * prefill and the appendRunResults flush.
 *
 * `firstSeenAt` is insert-only (kept on conflict); `title`/`file`/`lastSeenAt`
 * refresh from `excluded` (latest-wins). Deduped by `testId` first because a
 * multi-row `INSERT … ON CONFLICT` may not touch the same conflict-target
 * `(projectId, testId)` row twice in one statement — last entry wins, matching
 * the latest-title/file intent. `projectId` is constant (`scope.projectId`), so
 * `testId` alone keys the dedup. Empty input → no statements.
 */
export function buildTestCatalogUpsertStatements(
  scope: TenantScope,
  entries: ReadonlyArray<{ testId: string; title: string; file: string }>,
  nowSeconds: number,
  exec: BatchExecutor,
) {
  if (entries.length === 0) return [];
  const byTestId = new Map<string, { title: string; file: string }>();
  for (const e of entries)
    byTestId.set(e.testId, { title: e.title, file: e.file });
  // Sort by `testId` (projectId is constant per statement) so EVERY concurrent
  // writer emits the shared `(projectId, testId)` ON CONFLICT rows in the same
  // global order and can't AB/BA deadlock on the per-row locks Postgres takes as
  // it processes the VALUES list — the catalog row is shared across all runs of
  // a project, but the ingest transaction only locks the per-run row. Plain
  // code-unit comparison (NOT `localeCompare`, which is locale-dependent and
  // would let two processes disagree on order and re-open the cycle). Dedup
  // above already collapsed same-testId rows, so reordering distinct ids can't
  // change the upsert outcome.
  const rows = [...byTestId]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([testId, { title, file }]) => ({
      id: ulid(),
      projectId: scope.projectId,
      testId,
      title,
      file,
      firstSeenAt: nowSeconds,
      lastSeenAt: nowSeconds,
    }));
  return chunkInsertRows(rows).map((chunk) =>
    exec
      .insert(tests)
      .values(chunk)
      .onConflictDoUpdate({
        target: [tests.projectId, tests.testId],
        set: {
          title: sql`excluded."title"`,
          file: sql`excluded."file"`,
          lastSeenAt: sql`excluded."lastSeenAt"`,
        },
      }),
  );
}

/**
 * The `ON CONFLICT … DO UPDATE SET` for the /results upsert: the columns an
 * existing `(runId, testId)` row refreshes — everything a re-streamed result can
 * change. `id` and the identity columns (`projectId`, `runId`, `testId`) are
 * omitted (immutable), and `createdAt` is omitted DELIBERATELY: it is
 * insert-only, so a prefilled/re-sent row keeps its first-seen time instead of
 * drifting to the flush time (see the column doc on `testResults.createdAt`).
 * `updatedAt` carries the write time via `excluded`.
 *
 * `excluded` is Postgres's alias for the row proposed by the INSERT, so each
 * column takes the value the multi-row insert would have written — the batched
 * equivalent of the old per-row `.set({ … })`. Built lazily inside the builder
 * (not a module const) so `sql` is only referenced at call time, keeping ingest
 * importable under the stubbed-`void/db` unit tests.
 */
function resultUpsertSet() {
  return {
    title: sql`excluded."title"`,
    file: sql`excluded."file"`,
    projectName: sql`excluded."projectName"`,
    status: sql`excluded."status"`,
    durationMs: sql`excluded."durationMs"`,
    retryCount: sql`excluded."retryCount"`,
    errorMessage: sql`excluded."errorMessage"`,
    errorStack: sql`excluded."errorStack"`,
    workerIndex: sql`excluded."workerIndex"`,
    shardIndex: sql`excluded."shardIndex"`,
    updatedAt: sql`excluded."updatedAt"`,
  };
}

/**
 * Builds the upsert-and-replace statements for a /results batch. Returns the
 * statement array (built against the transaction executor `tx` for `runBatch`)
 * plus the clientKey→id map the reporter uses to fire per-test artifact uploads.
 *
 * Batched, so per-flush cost is a handful of statements regardless of batch size
 * (was ~4 statements PER already-existing result — and the reporter prefills a
 * `queued` row for every planned test, so every streamed result took that path,
 * making a 5000-result flush ~20k serial round-trips inside one transaction):
 *
 *   1. ONE multi-row `INSERT … ON CONFLICT (runId, testId) DO UPDATE` upserts
 *      every result — a fresh row inserts, a prefilled/re-sent row updates in
 *      place (keeping its `id` + `createdAt`). Chunked under the bound-param cap.
 *   2. THREE IN-list DELETEs (tags, annotations, attempts) clear the child rows
 *      of every touched result so the re-sent set replaces them cleanly. Chunked
 *      under the cap; a flush is ≤ MAX_RESULTS_PER_BATCH ids so it is one
 *      statement each in practice. Deleting a fresh row's (absent) children is a
 *      harmless no-op, so one uniform path covers insert + update.
 *   3. Chunked multi-row INSERTs of the new child rows.
 *
 * Ordering is load-bearing: the parent upsert (1) runs before the child INSERTs
 * (3) so a fresh row's FK target exists, and the child DELETEs (2) run before
 * those INSERTs so the replace semantics hold. `runBatch` runs the array in
 * order on one connection.
 *
 * `existingIds` is unused now (the upsert handles insert-vs-update in one
 * statement) but kept in the signature so the caller can thread the same
 * `resolveTestResultIds` result to `computeAggregateDelta`; `assignedIds` still
 * supplies each result's stable id (the existing id for a re-sent test).
 */
function buildResultInsertStatements(
  scope: TenantScope,
  runId: string,
  results: TestResultInput[],
  nowSeconds: number,
  _existingIds: Map<string, string>,
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
    shardIndex: number | null;
    createdAt: number;
    updatedAt: number;
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
    stdout: string | null;
    stderr: string | null;
    createdAt: number;
  }> = [];
  // Every touched result's id — the child rows of ALL of them are replaced (a
  // fresh row simply has none to delete).
  const childReplaceIds: string[] = [];
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
      shardIndex: result.shardIndex ?? null,
      createdAt: nowSeconds,
      updatedAt: nowSeconds,
    });

    childReplaceIds.push(testResultId);
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
        stdout: attempt.stdout ?? null,
        stderr: attempt.stderr ?? null,
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

  // (1) Upsert every result. On conflict the existing row keeps its id +
  //     createdAt and refreshes the mutable columns from `excluded`.
  for (const chunk of chunkInsertRows(insertRows)) {
    statements.push(
      exec
        .insert(testResults)
        .values(chunk)
        .onConflictDoUpdate({
          target: [testResults.runId, testResults.testId],
          set: resultUpsertSet(),
        }),
    );
  }
  // (2) Replace child rows: DELETE the existing set for every touched id. Each
  //     DELETE binds `projectId` (1) + N ids, so chunk N under the ceiling
  //     (one statement in practice — a flush is ≤ MAX_RESULTS_PER_BATCH ids).
  for (const chunk of chunkBySize(childReplaceIds, PG_MAX_BOUND_PARAMS - 1)) {
    statements.push(
      exec
        .delete(testTags)
        .where(childByTestResultsWhere(testTags, scope, chunk)),
    );
    statements.push(
      exec
        .delete(testAnnotations)
        .where(childByTestResultsWhere(testAnnotations, scope, chunk)),
    );
    statements.push(
      exec
        .delete(testResultAttempts)
        .where(childByTestResultsWhere(testResultAttempts, scope, chunk)),
    );
  }
  // (3) Insert the new child rows.
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
 * The test-status → aggregate-bucket mapping for the per-test aggregate: for
 * each non-`totalTests` column, the statuses that feed it. Both the JS delta
 * path (`statusBucket` → `computeAggregateDelta`) and the SQL recompute path
 * (`aggregateRecomputeStatement`) derive from this one table, so the two
 * encodings cannot drift; `status-bucketing.test.ts` asserts the parity
 * structurally.
 *
 * Membership is DERIVED from the shared `STATUS_BUCKETS` superset
 * (`@/lib/status-buckets`, the dependency-free source of truth the UI's
 * presentation collapse — `STATUS`/`statusGroupKey` in `@/lib/status` — also
 * reads) MINUS the wire-invisible statuses. The per-test wire enum never
 * carries `interrupted` (the reporter normalises interrupted attempts to
 * `skipped`; it only occurs as a run-level status these per-test buckets never
 * see), so `WIRE_INVISIBLE_STATUSES` filters it out here. That filter is the one
 * deliberate divergence from the UI table — now an explicit transform rather
 * than a hand-maintained omission, and `status-bucketing.test.ts` asserts
 * `STATUS_BUCKET_MEMBERS` equals `STATUS_BUCKETS` minus `WIRE_INVISIBLE_STATUSES`.
 */
export const STATUS_BUCKET_MEMBERS = {
  passed: STATUS_BUCKETS.passed.filter((s) => !WIRE_INVISIBLE_STATUSES.has(s)),
  failed: STATUS_BUCKETS.failed.filter((s) => !WIRE_INVISIBLE_STATUSES.has(s)),
  flaky: STATUS_BUCKETS.flaky.filter((s) => !WIRE_INVISIBLE_STATUSES.has(s)),
  skipped: STATUS_BUCKETS.skipped.filter(
    (s) => !WIRE_INVISIBLE_STATUSES.has(s),
  ),
} satisfies Record<
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

function aggregateDeltaStatement(
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
function activityBumpStatement(
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
export function statusMatchSql(statuses: readonly string[]) {
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
 * caller — `appendRunResults`, `reconcileAndBroadcast`, and `completeShardedRun`
 * all append the summary statement LAST and read it back through here. Returns
 * `null` (never a spurious `undefined`) when the final statement produced no
 * row, e.g. the run vanished between the ownership check and the batch.
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
 * (`@/lib/db/batch`); this is the run-scoped alias kept so `reconcileAndBroadcast`
 * reads "did the guarded UPDATE flip a row?" through a name local to the ingest
 * pipeline (the head-of-batch counterpart to `summaryFromBatchResults`).
 */
export const statementChangedRows = changedRows;

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
    await broadcastRunProgress(runId, recomputeScope.projectId, summary);
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
function shouldUpdateCodeowners(
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
async function maybeUpdateCodeowners(
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
async function bumpTeamActivity(
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
    shardIndex: r.shardIndex ?? null,
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
async function broadcastRunUpdate(
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
 * Fan a reconciled run summary out to BOTH the run room (run-detail page) and
 * the project room (open-runs list). The terminal broadcast tail shared by
 * `reconcileAndBroadcast` and `completeShardedRun`'s deferred-finalize path, so
 * the two-room publish is written once rather than mirrored by convention.
 * Synthetic runs broadcast too — the feed's origin policy is client-side.
 */
async function broadcastRunProgress(
  runId: string,
  projectId: string,
  summary: RunAggregateSummary,
): Promise<void> {
  await broadcastRunUpdate(runId, [], summary);
  const event: ProjectFeedEvent = { type: "run-progress", runId, summary };
  await broadcastProjectRoom(projectId, event);
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

/** Rolls back a fresh run when its atomic quota bump is rejected. */
export class RunQuotaOvershootError extends Error {
  constructor(readonly limit: number) {
    super("run quota exceeded");
    this.name = "RunQuotaOvershootError";
  }
}

/**
 * A fresh open whose planned-test set exceeds the per-run test-result ceiling
 * (`WRIGHTFUL_MAX_TEST_RESULTS_PER_RUN`). Thrown BEFORE any write: the payload
 * schema's own `MAX_PLANNED_TESTS` (100k) can sit above a lower
 * operator-configured ceiling, and every prefilled planned test persists a
 * `testResults` row — without this, the stated per-run maximum is bypassable
 * at open even though `appendRunResults` enforces it on every append.
 */
export class RunRowCapExceededError extends Error {
  constructor(
    readonly limit: number,
    readonly count: number,
  ) {
    super("planned-test set exceeds the per-run test-result ceiling");
    this.name = "RunRowCapExceededError";
  }
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
    // For a sharded run this is only the OPENER's slice at insert time; each
    // later shard's duplicate open merges its own count into
    // `shardExpectedTests` and re-derives this as the sum over the map (see
    // `reopenRunForWrites`), converging on the exact suite total.
    expectedTotalTests: expectedTestsFromOpenPayload(payload),
    // A sharded opener seeds the map with its own slice so the later re-sums
    // include it; null for non-sharded runs (the count above is already exact).
    shardExpectedTests: payload.shard
      ? { [String(payload.shard.index)]: expectedTestsFromOpenPayload(payload) }
      : null,
    // Total shards this run must wait for before it may finalize (from
    // `config.shard.total`). Null for a non-sharded suite — `completeRun` then
    // takes the legacy finalize-on-first-complete path. All shards send the
    // same total, so whichever wins the open sets the authoritative value.
    expectedShards: payload.shard?.total ?? null,
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
  opts: { runsQuotaLimit?: number } = {},
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
    // A later passing shard can no longer flip the run terminal early: the run
    // now stays 'running' until every shard has a `runShards` row and only then
    // takes the worst status across shards (see `completeRun`).
    await reopenRunForWrites(scope, existing[0].id, nowSeconds, payload);
    return { runId: existing[0].id, duplicate: true };
  }

  const runId = ulid();
  const plannedTests = payload.run.plannedTests ?? [];

  // The per-run row cap gates the open-time prefill too (fresh path only —
  // the duplicate path above prefills nothing, and its appends are capped in
  // `appendRunResults`). Checked before the transaction: the prefill count is
  // exactly the planned set's size, so there's no concurrency to serialize.
  const rowCap = env.WRIGHTFUL_MAX_TEST_RESULTS_PER_RUN;
  if (rowCap > 0 && plannedTests.length > rowCap) {
    throw new RunRowCapExceededError(rowCap, plannedTests.length);
  }

  const runValues = buildRunInsertValues(runId, scope, payload, nowSeconds);
  const runsQuotaLimit = opts.runsQuotaLimit;
  const enforceRuns =
    runsQuotaLimit !== undefined && Number.isFinite(runsQuotaLimit);
  // Kept as a runner so the stale-monitor recovery path can retry the same
  // transaction after clearing `monitorId`.
  const runOpenBatch = () =>
    db.transaction(async (tx) => {
      await tx.insert(runs).values(runValues);
      for (const stmt of buildQueuePrefillStatements(
        scope,
        runId,
        plannedTests,
        nowSeconds,
        tx,
        payload.shard?.index ?? null,
      )) {
        await stmt;
      }
      // Seed the tests catalog from the planned set so a test is searchable the
      // moment its run opens, before any result streams. Idempotent upsert, so
      // a re-opened run (CI re-run) just refreshes lastSeenAt.
      for (const stmt of buildTestCatalogUpsertStatements(
        scope,
        plannedTests,
        nowSeconds,
        tx,
      )) {
        await stmt;
      }
      if (enforceRuns) {
        const applied = await usageGuardedBumpStatement(
          scope.teamId,
          monthStartSeconds(nowSeconds),
          { runs: 1 },
          { dimension: "runs", limit: runsQuotaLimit },
          nowSeconds,
          tx,
        );
        if (applied.length === 0) {
          throw new RunQuotaOvershootError(runsQuotaLimit);
        }
      } else {
        const usageBump = usageBumpStatement(
          scope.teamId,
          monthStartSeconds(nowSeconds),
          { runs: 1 },
          nowSeconds,
          tx,
        );
        if (usageBump) await usageBump;
      }
    });

  // Recover the winner of a lost (projectId, idempotencyKey) race: re-read its
  // row and re-arm it for writes. Returns null when no winner exists (the unique
  // violation was something else), so the caller rethrows the original error.
  const recoverDuplicate = async (): Promise<OpenRunResult | null> => {
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
    if (!winner[0]) return null;
    await reopenRunForWrites(scope, winner[0].id, nowSeconds, payload);
    return { runId: winner[0].id, duplicate: true };
  };

  try {
    await runOpenBatch();
  } catch (err) {
    if (isForeignKeyViolation(err) && runValues.monitorId != null) {
      // A synthetic run whose monitor was deleted between scheduling and open:
      // the real `runs.monitorId` FK rejects the insert where the old logical FK
      // tolerated a dangling id. Drop the link (exactly what `onDelete: set
      // null` would have done) and retry the open ONCE. Gated on
      // `monitorId != null` so a projectId/teamId FK violation (both NOT NULL,
      // cascade parents) rethrows instead of looping on an unfixable cause.
      logger.warn(
        "synthetic run's monitor deleted mid-open; nulling monitorId",
        {
          runId,
          monitorId: runValues.monitorId,
        },
      );
      runValues.monitorId = null;
      try {
        await runOpenBatch();
      } catch (retryErr) {
        // The retry can still lose the (projectId, idempotencyKey) race to a
        // sibling shard — recover that the same way the first attempt would.
        if (!isUniqueViolation(retryErr)) throw retryErr;
        const dup = await recoverDuplicate();
        if (!dup) throw retryErr;
        return dup;
      }
      // Retry succeeded → fall through to the post-open broadcast path below.
    } else if (isUniqueViolation(err)) {
      // Lost the SELECT-then-INSERT race: sharded suites share one
      // idempotencyKey and open concurrently BY DESIGN, so the loser's insert
      // hitting `runs_project_idempotency_key_idx` is the expected hot path, not
      // a corner. Recover by re-reading the winner's row instead of bubbling a
      // 500 the reporter would have to absorb via retry.
      const dup = await recoverDuplicate();
      if (!dup) throw err;
      return dup;
    } else {
      throw err;
    }
  }
  await bumpTeamActivity(scope.teamId, nowSeconds);

  const summary: RunAggregateSummary = {
    totalTests: plannedTests.length,
    expectedTotalTests: runValues.expectedTotalTests ?? null,
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
      expectedTotalTests: runValues.expectedTotalTests ?? null,
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
  | { kind: "runClosed" }
  | { kind: "rowCapExceeded"; limit: number; count: number };

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
  // `completeRun` reads this off the same probe to decide the sharded
  // deferred-finalize path vs the legacy single-complete path.
  expectedShards: runs.expectedShards,
  totalTests: runs.totalTests,
} as const;

/**
 * The shard's planned-test count from an open payload: the reporter's explicit
 * `onBegin` count, falling back to the planned-test list's length for a
 * reporter that sends the list but not the count. In a sharded run this is one
 * SHARD's slice, not the suite total — Playwright filters the suite before
 * reporters see it, so the suite total only exists as the SUM across shards
 * (see `runs.shardExpectedTests`).
 */
function expectedTestsFromOpenPayload(payload: OpenRunPayload): number {
  return (
    payload.run.expectedTotalTests ?? (payload.run.plannedTests ?? []).length
  );
}

/**
 * Re-arm a terminal run's write window from `openRun`'s duplicate path: a
 * caller presenting the run's idempotency key is a legitimate re-stream (CI
 * re-run, late shard, seeder), so its appends/completes must not 409 against
 * the idle-run closure guard. Bumping `lastActivityAt` is sufficient —
 * `runClosedForWrites` keys on it.
 *
 * A sharded duplicate open (shards 2..N, or a shard's retry) additionally
 * merges that shard's planned-test count into `runs.shardExpectedTests` and
 * re-derives `expectedTotalTests` as the sum over the map — the only way to
 * know the full suite size, since each shard's `onBegin` sees only its own
 * slice. The merge arms are all evaluated in SQL inside one transaction that
 * first takes `FOR UPDATE` on the run row, so racing sibling opens serialize
 * and each loser re-evaluates against the winner's committed row.
 *
 * Idempotent per shard: `jsonb_set` keys on the shard index, so a reporter
 * retry or CI re-run of one shard REPLACES its count, and the exact re-sum
 * (not `greatest`) lets a shrunken re-run LOWER the total instead of showing
 * phantom pending tests forever. This is hand-written jsonb SQL the pglite
 * test lane can't fully vouch for — the statement shape is verified against
 * real Postgres 16 (see the 2026-07-06 worklog).
 *
 * A deterministic re-run may also reuse the idempotency key with the SAME or
 * different sharding. Stale shard state would strand or corrupt it: an
 * unsharded /complete against a leftover `expectedShards > 1` takes the
 * deferred-finalize path but inserts no `runShards` row, so the run never
 * finalizes; a changed total 409s with `invalidShard`; and a same-total
 * re-run would find the previous run's `runShards` completion rows already at
 * the full count, letting its FIRST shard /complete finalize against the dead
 * siblings' results. Both branches therefore RESET stale shard state on ANY
 * terminal re-open, gated on `status <> 'running'` evaluated under the row
 * lock — a duplicate open of a still-mid-flight run (a mixed-version fleet's
 * shardless opener, or an open retry) must never wipe a sibling shard's
 * backfill. The sharded branch additionally re-arms the run as in-flight
 * (`status='running'`, `completedAt=null`) in the same UPDATE; that flip is
 * the exactly-once latch for its reset arm (see `applyShardExpectedTests`).
 *
 * Exported for the pglite suites — the reset arms only fire on a terminal
 * row, which `openRun`'s public surface can't reach without a full re-run
 * round trip.
 */
export async function reopenRunForWrites(
  scope: TenantScope,
  runId: string,
  nowSeconds: number,
  payload: OpenRunPayload,
): Promise<void> {
  const shard = payload.shard;
  if (!shard) {
    // Unsharded re-open of a terminal run = an unsharded re-run: clear any
    // stale shard state so its /complete takes the legacy immediate-finalize
    // path, and re-base the expected total on THIS open's payload (the old
    // summed-across-shards value no longer describes the suite).
    const isRerun = sql`${runs.status} <> 'running'`;
    await db.transaction(async (tx) => {
      await tx
        .update(runs)
        .set({
          lastActivityAt: nowSeconds,
          expectedShards: sql`case when ${isRerun} then null else ${runs.expectedShards} end`,
          shardExpectedTests: sql`case when ${isRerun} then null else ${runs.shardExpectedTests} end`,
          expectedTotalTests: sql`case when ${isRerun} then cast(${expectedTestsFromOpenPayload(payload)} as integer) else ${runs.expectedTotalTests} end`,
        })
        .where(runByIdWhere(scope, runId));
      await tx
        .delete(runShards)
        .where(
          and(
            eq(runShards.projectId, scope.projectId),
            eq(runShards.runId, runId),
            sql`exists (select 1 from ${runs} where ${runByIdWhere(scope, runId)} and ${runs.status} <> 'running')`,
          ),
        );
    });
    return;
  }
  await applyShardExpectedTests(
    scope,
    runId,
    shard,
    expectedTestsFromOpenPayload(payload),
    nowSeconds,
  );
}

/**
 * The locked transaction behind {@link reopenRunForWrites}' sharded branch
 * (see its doc for the semantics). Exported so the `pg-integration/` suites can
 * execute the EXACT production statements against a real schema — this is
 * hand-written jsonb SQL the mocked unit lane can't vouch for.
 */
export async function applyShardExpectedTests(
  scope: TenantScope,
  runId: string,
  shard: { index: number; total: number },
  expectedTests: number,
  nowSeconds: number,
): Promise<void> {
  // A terminal run re-opened with a shard identity is a RE-RUN: the stored
  // expected-tests map and the previous run's `runShards` completion rows
  // describe a dead execution. Kept, a SAME-total re-run's first shard
  // /complete would see a full completion-row count and finalize against the
  // dead siblings' results (and a changed total would 409 every /complete).
  // So a terminal re-open starts the map over from '{}', REPLACES the total,
  // drops every previous completion row, and re-arms the run as in-flight
  // (status='running', completedAt=null). The status flip doubles as the
  // exactly-once latch: sibling opens serialize on the row lock below, and
  // the losers re-evaluate against the winner's now-'running' row, taking the
  // coalesce arm (each sibling re-merges its own slice as it opens).
  //
  // Accepted trade-off: a duplicate open delayed past the run's finalize
  // re-arms it and drops its completion rows, leaving the run 'running' for
  // the stale-run watchdog to interrupt. Reaching this path requires the
  // run's idempotency key, and the alternative — every same-total CI re-run
  // silently finalizing off stale sibling rows — is strictly worse.
  const isTerminalRerun = sql`${runs.status} <> 'running'`;
  const baseMap = sql`case when ${isTerminalRerun} then '{}'::jsonb else coalesce(${runs.shardExpectedTests}, '{}'::jsonb) end`;
  // The merged map, evaluated against the OLD row — SET expressions can't
  // reference each other's new values, so the same fragment appears in both
  // assignments (bound params duplicate; that's fine). `array[<text>]` is the
  // jsonb_set path (top-level key = the shard index); casts keep node-postgres'
  // text-typed bound params and the bigint `sum` driver-proof.
  const mergedMap = sql`jsonb_set(${baseMap}, array[${String(shard.index)}], to_jsonb(cast(${expectedTests} as integer)))`;
  await db.transaction(async (tx) => {
    // Lock order matches `completeShardedRun` (runs row first, then runShards)
    // so a terminal re-open racing a delayed shard /complete cannot deadlock.
    // The lock also freezes the status every arm below evaluates against.
    await tx
      .select({ id: runs.id })
      .from(runs)
      .where(runByIdWhere(scope, runId))
      .for("update");
    // The previous run's completion rows would count toward (or block) this
    // re-run's deferred finalize. Runs BEFORE the update flips the terminal
    // latch, guarded in SQL on the pre-update status so a mid-flight open (or
    // a losing sibling re-open) deletes nothing.
    await tx
      .delete(runShards)
      .where(
        and(
          eq(runShards.projectId, scope.projectId),
          eq(runShards.runId, runId),
          sql`exists (select 1 from ${runs} where ${runByIdWhere(scope, runId)} and ${runs.status} <> 'running')`,
        ),
      );
    await tx
      .update(runs)
      .set({
        shardExpectedTests: mergedMap,
        expectedTotalTests: sql`cast((select sum(cast(value as integer)) from jsonb_each_text(${mergedMap})) as integer)`,
        // Backfill expectedShards if the run's opener didn't set it (e.g. a
        // mixed-version fleet where an older shard opened first). `coalesce`
        // never lowers an already-set MID-FLIGHT total; only the terminal
        // re-run arm above may replace it.
        expectedShards: sql`case when ${isTerminalRerun} then cast(${shard.total} as integer) else coalesce(${runs.expectedShards}, cast(${shard.total} as integer)) end`,
        status: sql`case when ${isTerminalRerun} then 'running' else ${runs.status} end`,
        completedAt: sql`case when ${isTerminalRerun} then null else ${runs.completedAt} end`,
        lastActivityAt: nowSeconds,
      })
      .where(runByIdWhere(scope, runId));
  });
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
 * Append a batch of test results to a streaming run. Verifies the run belongs to
 * `scope.projectId` (404 otherwise), then in ONE transaction — guarded by a
 * `FOR UPDATE` lock on the run row — resolves each test's prior status, computes
 * the aggregate delta, and runs the upsert / tag-replace / annotation-replace /
 * per-attempt-insert / aggregate-delta statements. The last statement is
 * `.returning()` on the delta UPDATE (or the liveness bump when no delta) so the
 * broadcast summary is transactionally consistent with the per-test writes.
 *
 * Why the lock (mirrors `completeShardedRun`): the prev-status read and the
 * additive `runs.<counter> = col + delta` UPDATE must be consistent. Without it,
 * two concurrent identical flushes — the reporter's 30s per-attempt timeout
 * re-POSTs a batch while the first is still executing — each read the same
 * prev-status under READ COMMITTED and BOTH add the delta, double-applying the
 * live counters (it self-heals at /complete's recompute, but mid-run viewers see
 * inflated passed/failed/…). Reading the ids under the lock ALSO keeps the upsert
 * MAPPING race-safe: a serialized second flush sees the first's committed row, so
 * `assignedIds` resolves the real id instead of a phantom fresh ULID that the
 * `ON CONFLICT DO UPDATE` would discard (leaving the reporter's artifact PUTs
 * pointed at a non-existent testResultId).
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
  const rowCap = env.WRIGHTFUL_MAX_TEST_RESULTS_PER_RUN;

  const results = dedupeResultsByTestId(payload.results);
  const testIds = results.map((r) => r.testId);
  // Captured from inside the transaction for the post-commit artifact + broadcast
  // steps (the clientKey→id map and the id assignment resolved under the lock).
  let mapping: ResultMapping[] = [];
  let assignedIds = new Map<string, string>();
  let rowCapOutcome:
    | { kind: "rowCapExceeded"; limit: number; count: number }
    | undefined;
  //
  // testResults usage is deliberately NOT metered here. It used to upsert the
  // single `usageCounters` (teamId, month) row inside THIS transaction, which
  // serialized every concurrent /results flush across the WHOLE team on that
  // one row (the ingest hot-path contention ceiling). testResults is never
  // quota-gated (only `runs` at run-open and `artifactBytes` in
  // `registerArtifacts` are), so its count is derived on read
  // (`countTeamTestResults` → `loadTeamUsage`) and re-based by the
  // `rollup-usage` cron — no live counter needed. See the 2026-06-22 worklog.
  const summary = await db.transaction(async (tx) => {
    // Serialize concurrent /results flushes for THIS run (see the docstring).
    // Scoped to the single run row via runByIdWhere (projectId + id), not a
    // table lock; sibling runs and other projects are unaffected.
    const lockedRows = await tx
      .select({ id: runs.id, totalTests: runs.totalTests })
      .from(runs)
      .where(runByIdWhere(scope, runId))
      .for("update");
    if (!lockedRows[0]) return null;

    // Read prior status UNDER the lock so the delta and the upsert id-assignment
    // both see committed state — this is what closes the double-apply + phantom
    // -id races. Built against `tx` so it enrolls in the locked transaction.
    const resolved = await resolveTestResultIds(scope, runId, testIds, tx);
    const projectedCount =
      lockedRows[0].totalTests + testIds.length - resolved.existingIds.size;
    if (rowCap > 0 && projectedCount > rowCap) {
      rowCapOutcome = {
        kind: "rowCapExceeded",
        limit: rowCap,
        count: projectedCount,
      };
      return null;
    }
    assignedIds = resolved.assignedIds;
    const delta = computeAggregateDelta(results, resolved.prevStatusByTestId);

    const built = buildResultInsertStatements(
      scope,
      runId,
      results,
      nowSeconds,
      resolved.existingIds,
      resolved.assignedIds,
      tx,
    );
    mapping = built.mapping;
    // Sequential on purpose (like `runBatch`): one connection, ordered writes.
    for (const stmt of built.statements) await stmt;
    // Catalog the tests this flush touched (covers non-prefilled tests and shards
    // 2..N, which stream results without re-running the openRun prefill).
    for (const stmt of buildTestCatalogUpsertStatements(
      scope,
      results,
      nowSeconds,
      tx,
    ))
      await stmt;
    // Summary statement LAST: the delta UPDATE (`.returning()` the summary), or
    // the liveness-only bump when the delta nets to zero — a zero-bucket-change
    // flush still advances `lastActivityAt` so `staleRunFilter` won't reap a
    // suite that only re-sends already-counted results.
    const summaryStmt =
      aggregateDeltaStatement(scope, runId, delta, nowSeconds, tx) ??
      activityBumpStatement(scope, runId, nowSeconds, tx);
    return summaryFromBatchResults([await summaryStmt]);
  });
  if (rowCapOutcome) return rowCapOutcome;
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
  | { kind: "runClosed" }
  | { kind: "invalidShard"; expectedShards: number };

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
 * The worst (highest-severity) status across a set of shard outcomes — the
 * run's terminal status once every shard has reported. A fold over
 * `mergeRunStatus`, the SAME severity merge the single-complete path uses (one
 * severity model, not a parallel one): shard statuses are always terminal (never
 * "running"), so each step keeps the strictly-more-severe status and equal-
 * severity ties keep the first-seen one (failed vs timedout are equal severity
 * and both mean the run failed). That step is order-independent in severity, so
 * the order shards land in can't change the outcome. PURE, so the deferred-
 * finalize decision is unit-testable without a DB. Empty input → null (no shard
 * has finished yet); callers only finalize once it is non-empty.
 */
export function worstShardStatus(statuses: readonly string[]): string | null {
  if (statuses.length === 0) return null;
  return statuses.reduce((worst, status) => mergeRunStatus(worst, status));
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
 * Two paths, chosen by the run's `expectedShards` value:
 *
 *   - SHARDED (deferred finalize): each shard's /complete records a `runShards`
 *     row and the run STAYS `running` until every shard has reported, then
 *     takes the worst status across all shards. This is the fix for "the run
 *     shows succeeded while sibling shards are still streaming" — the terminal
 *     flip no longer happens on the FIRST shard's /complete. See
 *     `completeShardedRun`.
 *
 *   - LEGACY (non-sharded / pre-shard-aware reporter / degenerate 1-shard): the
 *     terminal status is merged ATOMICALLY in SQL on this single /complete — a
 *     `mergeRunStatusSql` UPDATE keeps the more-severe outcome across any raced
 *     completes, and durationMs/completedAt take the max. Unchanged behavior.
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

  // Prefer the run-side shard total so a mixed-version completion without a
  // shard identity cannot finalize while sibling shards are still running.
  const expectedShards =
    owner[0].expectedShards ?? payload.shard?.total ?? null;
  if (expectedShards !== null && expectedShards > 1) {
    if (
      payload.shard &&
      (payload.shard.total !== expectedShards ||
        payload.shard.index < 1 ||
        payload.shard.index > expectedShards)
    ) {
      return { kind: "invalidShard", expectedShards };
    }
    return completeShardedRun(
      scope,
      runId,
      payload,
      completedAt,
      nowSeconds,
      payload.shard,
      expectedShards,
    );
  }

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
  // Best-effort: posts both GitHub surfaces (check run + sticky PR comment)
  // and swallows its own errors.
  await postGithubRunSurfaces(runId, scope.projectId);

  return { kind: "ok", status: summary?.status ?? payload.status };
}

/**
 * The sharded-run branch of {@link completeRun}: record THIS shard's completion
 * and finalize the run only once every shard has reported.
 *
 * Concurrency: shards complete in any order and can overlap, so the whole
 * decision runs inside one transaction that first takes a `FOR UPDATE` lock on
 * the run row. That serializes every sibling's /complete for this run, which is
 * what makes the count reliable — whichever shard commits LAST acquires the lock
 * after all the others have committed their rows, sees the full count, and is
 * the one that flips the run terminal. Without the lock two shards could each
 * read a count below the total under READ COMMITTED and NEITHER would flip,
 * stranding the run at 'running' until the watchdog.
 *
 * Idempotent: the `runShards` upsert keys on `(projectId, runId, shardIndex)`,
 * so the reporter's aggressive /complete retry (or a duplicate) updates the
 * shard's row in place instead of double-counting toward `expectedShards`. The
 * final-status/duration/completedAt computations are all order-independent
 * (worst severity, max), so a re-run of the last shard's /complete lands on the
 * same terminal values.
 *
 * While the run is still waiting on shards it stays `running` (no completedAt),
 * so `runClosedForWrites` never closes it and a slow-but-alive straggler can
 * always complete — the terminal flip only happens once, when the count is met.
 */
async function completeShardedRun(
  scope: TenantScope,
  runId: string,
  payload: CompleteRunPayload,
  completedAt: number,
  nowSeconds: number,
  shard: CompleteRunPayload["shard"] | undefined,
  expectedShards: number,
): Promise<CompleteRunOutcome> {
  const { summary, allDone } = await db.transaction(async (tx) => {
    // Serialize concurrent shard /complete calls for THIS run (see docstring).
    await tx
      .select({ id: runs.id })
      .from(runs)
      .where(runByIdWhere(scope, runId))
      .for("update");

    // Anonymous completions cannot advance the completed-shard count.
    if (shard) {
      await tx
        .insert(runShards)
        .values({
          id: ulid(),
          projectId: scope.projectId,
          runId,
          shardIndex: shard.index,
          shardTotal: shard.total,
          status: payload.status,
          durationMs: payload.durationMs,
          completedAt,
          createdAt: nowSeconds,
        })
        .onConflictDoUpdate({
          target: [runShards.projectId, runShards.runId, runShards.shardIndex],
          set: {
            status: payload.status,
            durationMs: payload.durationMs,
            completedAt,
            shardTotal: shard.total,
          },
        });
    }

    const shardRows = await tx
      .select({
        status: runShards.status,
        durationMs: runShards.durationMs,
        completedAt: runShards.completedAt,
      })
      .from(runShards)
      .where(
        and(
          eq(runShards.projectId, scope.projectId),
          eq(runShards.runId, runId),
        ),
      );

    const done = shardRows.length >= expectedShards;

    if (done) {
      // Every shard reported: the run's terminal status is the worst outcome
      // across shards; duration/completedAt take the max (the last shard's
      // wall-clock is the run's). `?? payload.status` can't actually fire —
      // shardRows always holds at least this shard — but keeps the type honest.
      const finalStatus =
        worstShardStatus(shardRows.map((r) => r.status)) ?? payload.status;
      const maxDuration = shardRows.reduce(
        (m, r) => Math.max(m, r.durationMs),
        payload.durationMs,
      );
      const maxCompletedAt = shardRows.reduce(
        (m, r) => Math.max(m, r.completedAt),
        completedAt,
      );
      await tx
        .update(runs)
        .set({
          status: finalStatus,
          durationMs: maxDuration,
          completedAt: maxCompletedAt,
          lastActivityAt: nowSeconds,
          expectedShards,
        })
        .where(runByIdWhere(scope, runId));
    } else {
      // Still waiting on shards: keep the run visibly in-progress — a pure
      // liveness bump, no status/completedAt flip. `expectedShards` is already
      // persisted (at open, then coalesce-backfilled on every duplicate open)
      // and the done branch re-asserts it, so it needn't be rewritten here.
      await tx
        .update(runs)
        .set({ lastActivityAt: nowSeconds })
        .where(runByIdWhere(scope, runId));
    }

    // Reconcile counters from the testResults actually present (straggler
    // /results that raced this) and project the broadcast summary — it reads
    // the status/completedAt just written above, so a not-yet-done run's
    // summary carries status='running'.
    const recomputed = await aggregateRecomputeStatement(
      { projectId: scope.projectId },
      runId,
      tx,
    );
    return { summary: summaryFromBatchResults([recomputed]), allDone: done };
  });

  await bumpTeamActivity(scope.teamId, nowSeconds);

  if (summary) {
    await broadcastRunProgress(runId, scope.projectId, summary);
  }

  // Do not publish completed GitHub surfaces until every shard is done.
  if (allDone) {
    await postGithubRunSurfaces(runId, scope.projectId);
  }

  return {
    kind: "ok",
    status: summary?.status ?? (allDone ? payload.status : "running"),
  };
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
 * Shard-aware: a sharded run only sits at 'running' past the window when a shard
 * never completed (SIGKILL) — but sibling shards that DID complete may have
 * FAILED. Collapsing such a run to "interrupted" (severity 3) would mask a real
 * failure (severity 4). So the finalize status is the worst of the completed
 * shards' statuses AND "interrupted" (the run is incomplete, so at least
 * interrupted). A non-sharded run has no `runShards` rows → the set is just
 * {"interrupted"} → the original behavior.
 *
 * `run` ids come from a trusted DB row (not user input), so no Authorized* brand
 * is required here — the recompute is keyed by the run's own projectId.
 */
export async function finalizeStaleRun(
  run: { id: string; projectId: string; teamId: string },
  completedAt: number,
): Promise<void> {
  const shardRows = await db
    .select({ status: runShards.status })
    .from(runShards)
    .where(
      and(eq(runShards.projectId, run.projectId), eq(runShards.runId, run.id)),
    );
  // "interrupted" is always in the set: the run is being force-finalized while
  // stuck at 'running', so it is incomplete by definition.
  const finalStatus =
    worstShardStatus([...shardRows.map((r) => r.status), "interrupted"]) ??
    "interrupted";
  await reconcileAndBroadcast(
    run.id,
    (tx) =>
      tx
        .update(runs)
        .set({
          status: finalStatus,
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
  // Watchdog-finalized runs still update the best-effort GitHub surfaces.
  await postGithubRunSurfaces(run.id, run.projectId);
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
