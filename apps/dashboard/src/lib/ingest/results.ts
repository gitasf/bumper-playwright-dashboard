import { db } from "void/db";
import { env } from "void/env";
import { runs } from "@schema";
import { runByIdWhere, type TenantScope } from "@/lib/scope";
import { broadcastProjectRoom } from "@/realtime/publish";
import type { AppendResultsPayload, TestResultInput } from "@/lib/schemas";
import type { ProjectFeedEvent } from "@/realtime/events";
import { RUN_WRITE_GUARD_COLUMNS, runClosedForWrites } from "./lifecycle";
import {
  activityBumpStatement,
  aggregateDeltaStatement,
  broadcastRunUpdate,
  buildChangedTests,
  buildResultInsertStatements,
  buildTestCatalogUpsertStatements,
  bumpTeamActivity,
  computeAggregateDelta,
  resolveTestResultIds,
  summaryFromBatchResults,
  type ResultMapping,
} from "./write-and-publish";

export type AppendRunResultsOutcome =
  | { kind: "ok"; mapping: ResultMapping[] }
  | { kind: "notFound" }
  | { kind: "runClosed" }
  | { kind: "rowCapExceeded"; limit: number; count: number };

/** Last-write-wins dedupe for malformed batches containing duplicate test ids. */
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
 * Append results under a per-run `FOR UPDATE` lock. The lock keeps prior-status
 * reads, stable id assignment, row-cap enforcement, and additive aggregates in
 * one serial decision for this run.
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
  const testIds = results.map((result) => result.testId);
  let mapping: ResultMapping[] = [];
  let assignedIds = new Map<string, string>();
  let rowCapOutcome:
    | { kind: "rowCapExceeded"; limit: number; count: number }
    | undefined;

  // testResults usage is deliberately NOT metered here. It used to upsert the
  // single `usageCounters` (teamId, month) row inside THIS transaction, which
  // serialized every concurrent /results flush across the WHOLE team on that one
  // row — the ingest hot-path contention ceiling. testResults is never
  // quota-gated (only `runs` at run-open and `artifactBytes` in
  // `registerArtifacts` are), so its count is derived on read
  // (`countTeamTestResults` → `loadTeamUsage`) and re-based by the
  // `rollup-usage` cron; no live counter is needed. See the 2026-06-22 worklog.
  // Adding a usage bump here would reintroduce that ceiling.
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
      resolved.assignedIds,
      tx,
    );
    mapping = built.mapping;
    for (const statement of built.statements) await statement;
    for (const statement of buildTestCatalogUpsertStatements(
      scope,
      results,
      nowSeconds,
      tx,
    )) {
      await statement;
    }
    const summaryStatement =
      aggregateDeltaStatement(scope, runId, delta, nowSeconds, tx) ??
      activityBumpStatement(scope, runId, nowSeconds, tx);
    return summaryFromBatchResults([await summaryStatement]);
  });

  if (rowCapOutcome) return rowCapOutcome;
  if (!summary) return { kind: "notFound" };
  await bumpTeamActivity(scope.teamId, nowSeconds);

  await broadcastRunUpdate(
    runId,
    buildChangedTests(results, assignedIds),
    summary,
  );
  const progressEvent: ProjectFeedEvent = {
    type: "run-progress",
    runId,
    summary,
  };
  await broadcastProjectRoom(scope.projectId, progressEvent);
  return { kind: "ok", mapping };
}
