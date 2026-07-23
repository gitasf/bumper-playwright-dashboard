import {
  and,
  db,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  lte,
  ne,
  sql,
} from "void/db";
import { runs, testResultAttempts, testResults, tests } from "@schema";
import { ciRunsJoinOn } from "@/lib/analytics/filters";
import {
  rankFlakyTests,
  type RankedFlaky,
} from "@/lib/analytics/flaky-ranking";
import { buildTestSearchWhere } from "@/lib/command-search";
import { normalizeErrorSignature } from "@/lib/error-signature";
import {
  childProjectScopeWhere,
  ciRunsScopeWhere,
  runScopeWhere,
  type TenantScope,
} from "@/lib/scope";

/**
 * Statuses whose rows carry a failure worth fingerprinting and co-relating.
 * Hand-listed like `run-diff.ts`'s FAILING_STATUSES: `interrupted` never
 * appears on the per-test wire enum and `queued`/`skipped` carry no error.
 */
const FAILURE_STATUSES = ["flaky", "failed", "timedout"] as const;

const MAX_WINDOW_ROWS_PER_TEST = 500;
/**
 * Aggregate window-row budget across ALL selected tests. The per-test cap
 * alone still lets a max-size call (50 tests × 500 rows × 2 KB error heads)
 * hold ~50 M chars of error text in Worker memory; splitting one budget
 * across the selection bounds the aggregate instead. At the default
 * `limit: 10` each test keeps the full 500 rows.
 */
const WINDOW_ROW_BUDGET = 5000;
const MAX_CO_FAILURE_RUNS = 200;
/** Aggregate row budget for the co-failure read, split per run — a mass-failure era must not make it unbounded. */
const MAX_CO_FAILURE_ROWS = 5000;
const MAX_CO_FAILURES_PER_TEST = 10;
/** Signature groups returned per test — `distinctSignatures` reports the uncapped total. */
const MAX_SIGNATURES_PER_TEST = 10;
const MAX_MATCHED_TESTS = 50;
/**
 * Only this many leading chars of an error are fetched: a signature uses the
 * first meaningful line ({@link normalizeErrorSignature}), and ingest allows
 * messages/stacks up to 64/128 KB — pulling those whole for thousands of
 * window rows would swamp Worker memory. Full text stays behind
 * `get_test_result`.
 */
const ERROR_HEAD_CHARS = 2048;

function isFailureStatus(status: string): boolean {
  return (FAILURE_STATUSES as readonly string[]).includes(status);
}

/**
 * Byte-bounded error head — message first, stack as fallback. A blank or
 * whitespace-only message counts as absent (`nullif(trim(…), '')`), so a
 * useful stack is not shadowed by an empty non-null message.
 */
function errorHeadSql() {
  return sql<
    string | null
  >`left(coalesce(nullif(trim(${testResults.errorMessage}), ''), ${testResults.errorStack}), ${ERROR_HEAD_CHARS})`;
}

export interface McpFlakyDiagnosisOptions {
  days: number;
  branch: string | null;
  limit: number;
}

/** The single selector `get_test_history` resolves — the tool layer validates "exactly one". */
export interface McpTestHistorySelector {
  kind: "testId" | "file" | "query";
  value: string;
}

export interface McpTestHistoryOptions {
  selector: McpTestHistorySelector;
  days: number;
  branch: string | null;
  limit: number;
}

type WindowRow = Awaited<ReturnType<typeof loadWindowRows>>[number];
type EnrichedRow = WindowRow & { signature: string | null };
type CoFailureRow = Awaited<ReturnType<typeof loadCoFailureRows>>[number];

function windowStart(days: number): number {
  return Math.floor(Date.now() / 1000) - days * 86400;
}

async function loadWindowRows(
  scope: TenantScope,
  testIds: string[],
  opts: McpFlakyDiagnosisOptions,
) {
  const perTestRowCap = Math.min(
    MAX_WINDOW_ROWS_PER_TEST,
    Math.max(1, Math.floor(WINDOW_ROW_BUDGET / testIds.length)),
  );
  const conditions = [
    childProjectScopeWhere(testResults.projectId, scope),
    runScopeWhere(scope),
    inArray(testResults.testId, testIds),
    gte(testResults.createdAt, windowStart(opts.days)),
    // Exactly the statuses the ranking counters cover — `queued` prefills and
    // `skipped` rows must not inflate analyzedRows or spend the row budget.
    inArray(testResults.status, [...FAILURE_STATUSES, "passed"]),
  ];
  if (opts.branch) conditions.push(eq(runs.branch, opts.branch));

  const windowed = db
    .select({
      id: testResults.id,
      runId: testResults.runId,
      testId: testResults.testId,
      title: testResults.title,
      file: testResults.file,
      status: testResults.status,
      errorHead: errorHeadSql().as("errorHead"),
      createdAt: testResults.createdAt,
      rowNumber:
        sql<number>`cast(row_number() over (partition by ${testResults.testId} order by ${testResults.createdAt} desc, ${testResults.id} desc) as integer)`.as(
          "rowNumber",
        ),
    })
    .from(testResults)
    .innerJoin(runs, ciRunsJoinOn())
    .where(and(...conditions))
    .as("windowed_mcp_results");

  return db
    .select({
      id: windowed.id,
      runId: windowed.runId,
      testId: windowed.testId,
      title: windowed.title,
      file: windowed.file,
      status: windowed.status,
      errorHead: windowed.errorHead,
      createdAt: windowed.createdAt,
    })
    .from(windowed)
    .where(lte(windowed.rowNumber, perTestRowCap))
    .orderBy(desc(windowed.createdAt), desc(windowed.id));
}

async function loadCurrentHealth(
  scope: TenantScope,
  testIds: string[],
  branch: string | null,
) {
  const conditions = [ciRunsScopeWhere(scope), isNotNull(runs.completedAt)];
  if (branch) conditions.push(eq(runs.branch, branch));

  const [latestRun] = await db
    .select({
      latestRunId: runs.id,
      latestRunStatus: runs.status,
      branch: runs.branch,
      at: runs.createdAt,
    })
    .from(runs)
    .where(and(...conditions))
    .orderBy(desc(runs.createdAt), desc(runs.id))
    .limit(1);

  if (!latestRun)
    return { currentHealth: null, statuses: new Map<string, string>() };

  const statusRows = await db
    .select({ testId: testResults.testId, status: testResults.status })
    .from(testResults)
    .where(
      and(
        childProjectScopeWhere(testResults.projectId, scope),
        eq(testResults.runId, latestRun.latestRunId),
        inArray(testResults.testId, testIds),
      ),
    );

  return {
    currentHealth: latestRun,
    statuses: new Map(statusRows.map((row) => [row.testId, row.status])),
  };
}

async function loadCoFailureRows(scope: TenantScope, runIds: string[]) {
  if (runIds.length === 0) return [];
  // Split the row budget per run (newest failures first within each) so one
  // mass-failure run cannot consume the whole read and silently starve the
  // other budgeted runs out of `failuresByRun`.
  const perRunRowCap = Math.max(
    1,
    Math.floor(MAX_CO_FAILURE_ROWS / runIds.length),
  );
  const ranked = db
    .select({
      runId: testResults.runId,
      testId: testResults.testId,
      title: testResults.title,
      rowNumber:
        sql<number>`cast(row_number() over (partition by ${testResults.runId} order by ${testResults.createdAt} desc, ${testResults.id} desc) as integer)`.as(
          "rowNumber",
        ),
    })
    .from(testResults)
    .innerJoin(runs, ciRunsJoinOn())
    .where(
      and(
        childProjectScopeWhere(testResults.projectId, scope),
        runScopeWhere(scope),
        inArray(testResults.runId, runIds),
        inArray(testResults.status, [...FAILURE_STATUSES]),
      ),
    )
    .as("co_failure_rows");

  return db
    .select({
      runId: ranked.runId,
      testId: ranked.testId,
      title: ranked.title,
    })
    .from(ranked)
    .where(lte(ranked.rowNumber, perRunRowCap));
}

/**
 * Latest result per (test, status) over the FULL window. Representatives must
 * not disappear when a high-volume test's newest flaky/failed/passed row falls
 * outside the {@link MAX_WINDOW_ROWS_PER_TEST} sample — the ranking counters
 * are full-window, so the representative ids must be too. Bounded to
 * 4 × |testIds| rows.
 */
async function loadLatestRowsByStatus(
  scope: TenantScope,
  testIds: string[],
  opts: McpFlakyDiagnosisOptions,
) {
  const conditions = [
    childProjectScopeWhere(testResults.projectId, scope),
    runScopeWhere(scope),
    inArray(testResults.testId, testIds),
    gte(testResults.createdAt, windowStart(opts.days)),
    inArray(testResults.status, [...FAILURE_STATUSES, "passed"]),
  ];
  if (opts.branch) conditions.push(eq(runs.branch, opts.branch));

  return (
    db
      .selectDistinctOn([testResults.testId, testResults.status], {
        testId: testResults.testId,
        status: testResults.status,
        id: testResults.id,
        createdAt: testResults.createdAt,
      })
      .from(testResults)
      .innerJoin(runs, ciRunsJoinOn())
      // `distinct on` requires the distinct columns to lead the ordering; the
      // createdAt/id DESC tiebreak makes "the" row per pair the latest one.
      .where(and(...conditions))
      .orderBy(
        testResults.testId,
        testResults.status,
        desc(testResults.createdAt),
        desc(testResults.id),
      )
  );
}

interface LatestRowByStatus {
  id: string;
  createdAt: number;
}

/** The newer of two optional rows — createdAt, then id (ULIDs sort by time). */
function newerRow(
  a: LatestRowByStatus | undefined,
  b: LatestRowByStatus | undefined,
): LatestRowByStatus | null {
  if (!a) return b ?? null;
  if (!b) return a;
  if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt ? a : b;
  return a.id > b.id ? a : b;
}

/** Cross-test context {@link buildTestDossier} reads alongside one test's own rows. */
interface DossierContext {
  /** testId → status → latest full-window result ({@link loadLatestRowsByStatus}). */
  latestByTestStatus: Map<string, Map<string, LatestRowByStatus>>;
  /** signature → the selected testIds that produced it in the window. */
  signatureOwners: Map<string, Set<string>>;
  /** The flaky runs co-failure analysis was bounded to — per-test budgeted, newest first. */
  coFailureRunIds: Set<string>;
  flakyRunIdsByTest: Map<string, Set<string>>;
  failuresByRun: Map<string, CoFailureRow[]>;
  /** testId → status in the latest completed CI run. */
  latestStatusByTest: Map<string, string>;
}

/** One test's diagnosis entry, from its (newest-first) window rows + cross-test context. Pure. */
function buildTestDossier(
  rankedRow: RankedFlaky,
  ownRows: EnrichedRow[],
  ctx: DossierContext,
) {
  const latest = ownRows[0];
  const byStatus = ctx.latestByTestStatus.get(rankedRow.testId);
  const latestFlaky = byStatus?.get("flaky") ?? null;
  const latestHardFail = newerRow(
    byStatus?.get("failed"),
    byStatus?.get("timedout"),
  );
  const signatureGroups = new Map<
    string,
    { count: number; representativeTestResultId: string }
  >();

  for (const row of ownRows) {
    if (!row.signature) continue;
    const group = signatureGroups.get(row.signature);
    signatureGroups.set(row.signature, {
      count: (group?.count ?? 0) + 1,
      representativeTestResultId: group?.representativeTestResultId ?? row.id,
    });
  }

  const coFailureCounts = new Map<
    string,
    { title: string; sharedRuns: number }
  >();
  let coFailureRunsAnalyzed = 0;
  for (const runId of ctx.flakyRunIdsByTest.get(rankedRow.testId) ?? []) {
    if (!ctx.coFailureRunIds.has(runId)) continue;
    coFailureRunsAnalyzed += 1;
    for (const row of ctx.failuresByRun.get(runId) ?? []) {
      if (row.testId === rankedRow.testId) continue;
      const existing = coFailureCounts.get(row.testId);
      coFailureCounts.set(row.testId, {
        title: row.title,
        sharedRuns: (existing?.sharedRuns ?? 0) + 1,
      });
    }
  }

  const hardFailures = rankedRow.hardFailureCount;
  const latestStatus = ctx.latestStatusByTest.get(rankedRow.testId) ?? null;
  return {
    testId: rankedRow.testId,
    title: latest?.title ?? "",
    file: latest?.file ?? "",
    samples: rankedRow.passedCount + rankedRow.flakyCount + hardFailures,
    /**
     * Rows the signature breakdown below was computed from — the test's newest
     * window rows, capped per test and by the selection-wide
     * {@link WINDOW_ROW_BUDGET}. When this is less than `samples`, the
     * breakdown is sampled; the counters above always cover the full window.
     */
    analyzedRows: ownRows.length,
    firstAttemptFailures: rankedRow.flakyCount + hardFailures,
    retryPasses: rankedRow.flakyCount,
    hardFailures,
    passedCount: rankedRow.passedCount,
    flakeRatePct: Math.round(rankedRow.flakeRatePct * 10) / 10,
    lastFlakyAt: latestFlaky?.createdAt ?? null,
    passedInLatestRun: latestStatus === null ? null : latestStatus === "passed",
    latestStatus,
    // Full-window like the counters — never null just because the newest
    // occurrence fell outside the analyzedRows sample.
    representatives: {
      latestFlakyTestResultId: latestFlaky?.id ?? null,
      latestHardFailTestResultId: latestHardFail?.id ?? null,
      latestPassedTestResultId: byStatus?.get("passed")?.id ?? null,
    },
    /** Total distinct signatures in the window; > signatures.length means the list was capped. */
    distinctSignatures: signatureGroups.size,
    signatures: [...signatureGroups.entries()]
      .map(([signature, group]) => ({
        signature,
        count: group.count,
        correlatedTests: Math.max(
          0,
          (ctx.signatureOwners.get(signature)?.size ?? 1) - 1,
        ),
        representativeTestResultId: group.representativeTestResultId,
      }))
      .sort(
        (a, b) => b.count - a.count || a.signature.localeCompare(b.signature),
      )
      .slice(0, MAX_SIGNATURES_PER_TEST),
    /** This test's flaky runs the coFailures below were computed from (per-test budgeted). */
    coFailureRunsAnalyzed,
    coFailures: [...coFailureCounts.entries()]
      .map(([testId, value]) => ({ testId, ...value }))
      .sort(
        (a, b) => b.sharedRuns - a.sharedRuns || a.title.localeCompare(b.title),
      )
      .slice(0, MAX_CO_FAILURES_PER_TEST),
  };
}

/** Heavy, bounded flaky-test dossier behind `diagnose_flaky_tests`. */
export async function loadMcpFlakyDiagnosis(
  scope: TenantScope,
  opts: McpFlakyDiagnosisOptions,
) {
  const ranked = await rankFlakyTests(scope, {
    windowStartSec: windowStart(opts.days),
    branch: opts.branch,
  });
  const selected = ranked.slice(0, opts.limit);
  const base = {
    windowDays: opts.days,
    branch: opts.branch,
    totalFlakyTests: ranked.length,
  };
  if (selected.length === 0) return { ...base, currentHealth: null, tests: [] };

  const testIds = selected.map((row) => row.testId);
  const [rows, representativeRows] = await Promise.all([
    loadWindowRows(scope, testIds, opts),
    loadLatestRowsByStatus(scope, testIds, opts),
  ]);
  const latestByTestStatus = new Map<string, Map<string, LatestRowByStatus>>();
  for (const row of representativeRows) {
    const byStatus =
      latestByTestStatus.get(row.testId) ??
      new Map<string, LatestRowByStatus>();
    byStatus.set(row.status, { id: row.id, createdAt: row.createdAt });
    latestByTestStatus.set(row.testId, byStatus);
  }

  // One enrichment pass: fingerprint each failure row once, group rows per
  // test, and collect each test's flaky runs (newest-first) for co-failure
  // analysis.
  const rowsByTest = new Map<string, EnrichedRow[]>();
  const signatureOwners = new Map<string, Set<string>>();
  const flakyRunIdsByTest = new Map<string, Set<string>>();
  for (const row of rows) {
    const signature = isFailureStatus(row.status)
      ? normalizeErrorSignature(row.errorHead)
      : null;
    const ownRows = rowsByTest.get(row.testId) ?? [];
    ownRows.push({ ...row, signature });
    rowsByTest.set(row.testId, ownRows);
    if (signature) {
      const owners = signatureOwners.get(signature) ?? new Set<string>();
      owners.add(row.testId);
      signatureOwners.set(signature, owners);
    }
    if (row.status === "flaky") {
      const runIds = flakyRunIdsByTest.get(row.testId) ?? new Set<string>();
      runIds.add(row.runId);
      flakyRunIdsByTest.set(row.testId, runIds);
    }
  }

  // Allocate the run budget per test, newest runs first (the per-test sets are
  // insertion-ordered from the newest-first row scan), so one high-volume test
  // cannot starve the others' co-failure analysis.
  const perTestRunBudget = Math.max(
    1,
    Math.floor(MAX_CO_FAILURE_RUNS / selected.length),
  );
  const coFailureRunIds = new Set<string>();
  for (const runIds of flakyRunIdsByTest.values()) {
    let taken = 0;
    for (const runId of runIds) {
      if (taken >= perTestRunBudget) break;
      coFailureRunIds.add(runId);
      taken += 1;
    }
  }
  const [coFailureRows, health] = await Promise.all([
    loadCoFailureRows(scope, [...coFailureRunIds]),
    loadCurrentHealth(scope, testIds, opts.branch),
  ]);
  const failuresByRun = new Map<string, CoFailureRow[]>();
  for (const row of coFailureRows) {
    const runRows = failuresByRun.get(row.runId) ?? [];
    runRows.push(row);
    failuresByRun.set(row.runId, runRows);
  }

  const ctx: DossierContext = {
    latestByTestStatus,
    signatureOwners,
    coFailureRunIds,
    flakyRunIdsByTest,
    failuresByRun,
    latestStatusByTest: health.statuses,
  };
  return {
    ...base,
    currentHealth: health.currentHealth,
    tests: selected.map((rankedRow) =>
      buildTestDossier(rankedRow, rowsByTest.get(rankedRow.testId) ?? [], ctx),
    ),
  };
}

/**
 * Resolve the selector against the `tests` catalog (identity table, one row
 * per test, trigram-indexed — the same table the ⌘K search reads). Ingest
 * catalogs every test atomically with its results, so resolving through it is
 * complete: a testId with results but no catalog row cannot exist.
 */
async function resolveHistoryTests(
  scope: TenantScope,
  selector: McpTestHistorySelector,
) {
  const where =
    selector.kind === "testId"
      ? and(
          childProjectScopeWhere(tests.projectId, scope),
          eq(tests.testId, selector.value),
        )
      : selector.kind === "file"
        ? and(
            childProjectScopeWhere(tests.projectId, scope),
            eq(tests.file, selector.value),
          )
        : buildTestSearchWhere(scope, selector.value);
  return (
    db
      .select({ testId: tests.testId, title: tests.title, file: tests.file })
      .from(tests)
      .where(where)
      .orderBy(desc(tests.lastSeenAt), tests.testId)
      // +1 probes truncation; the caller slices back to the cap and reports it.
      .limit(MAX_MATCHED_TESTS + 1)
  );
}

/** One-call execution and retry timeline behind `get_test_history`. */
export async function loadMcpTestHistory(
  scope: TenantScope,
  opts: McpTestHistoryOptions,
) {
  const matched = await resolveHistoryTests(scope, opts.selector);
  /** True when the selector matched more catalog tests than the cap — narrow the selector. */
  const matchedTestsTruncated = matched.length > MAX_MATCHED_TESTS;
  const matchedTests = matchedTestsTruncated
    ? matched.slice(0, MAX_MATCHED_TESTS)
    : matched;
  const testIds = matchedTests.map((test) => test.testId);
  if (testIds.length === 0)
    return { matchedTests, matchedTestsTruncated, executions: [] };

  const conditions = [
    childProjectScopeWhere(testResults.projectId, scope),
    runScopeWhere(scope),
    inArray(testResults.testId, testIds),
    gte(testResults.createdAt, windowStart(opts.days)),
    ne(testResults.status, "queued"),
  ];
  if (opts.branch) conditions.push(eq(runs.branch, opts.branch));

  const rows = await db
    .select({
      testResultId: testResults.id,
      testId: testResults.testId,
      title: testResults.title,
      file: testResults.file,
      runId: testResults.runId,
      at: runs.createdAt,
      commit: runs.commitSha,
      branch: runs.branch,
      prNumber: runs.prNumber,
      status: testResults.status,
      durationMs: testResults.durationMs,
      workerIndex: testResults.workerIndex,
      shardIndex: testResults.shardIndex,
      errorHead: errorHeadSql().as("errorHead"),
    })
    .from(testResults)
    .innerJoin(runs, ciRunsJoinOn())
    .where(and(...conditions))
    .orderBy(desc(runs.createdAt), desc(testResults.createdAt), testResults.id)
    .limit(opts.limit);

  if (rows.length === 0)
    return { matchedTests, matchedTestsTruncated, executions: [] };
  const attemptRows = await db
    .select({
      testResultId: testResultAttempts.testResultId,
      attempt: testResultAttempts.attempt,
      status: testResultAttempts.status,
      durationMs: testResultAttempts.durationMs,
    })
    .from(testResultAttempts)
    .where(
      and(
        childProjectScopeWhere(testResultAttempts.projectId, scope),
        inArray(
          testResultAttempts.testResultId,
          rows.map((row) => row.testResultId),
        ),
      ),
    )
    .orderBy(testResultAttempts.testResultId, testResultAttempts.attempt);
  const attemptsByResult = new Map<string, typeof attemptRows>();
  for (const attempt of attemptRows) {
    const attempts = attemptsByResult.get(attempt.testResultId) ?? [];
    attempts.push(attempt);
    attemptsByResult.set(attempt.testResultId, attempts);
  }

  return {
    matchedTests,
    matchedTestsTruncated,
    executions: rows.map((row) => ({
      testResultId: row.testResultId,
      testId: row.testId,
      title: row.title,
      file: row.file,
      runId: row.runId,
      at: row.at,
      commit: row.commit,
      branch: row.branch,
      prNumber: row.prNumber,
      status: row.status,
      durationMs: row.durationMs,
      attempts: (attemptsByResult.get(row.testResultId) ?? []).map(
        ({ attempt, status, durationMs }) => ({
          attempt,
          status,
          durationMs,
        }),
      ),
      workerIndex: row.workerIndex,
      shardIndex: row.shardIndex,
      errorSignature: normalizeErrorSignature(row.errorHead),
    })),
  };
}
