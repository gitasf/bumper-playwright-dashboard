import type { GetColumnData } from "drizzle-orm";
import { db } from "void/db";
import { runs } from "@schema";
import { runByIdWhere, type TenantScope } from "@/lib/scope";

/**
 * The canonical by-id run read-model: ONE definition of "a run summary" (the
 * column projection) plus ONE tenant-scoped fetch+unwrap, shared by the three
 * read surfaces that return a single run — MCP `get_run`
 * (`@/lib/mcp/queries`), the public `GET /api/v1/runs/:runId`, and the
 * session-authed `/runs/:runId/summary` hovercard route.
 *
 * Before this module each surface re-spelled BOTH halves independently: its
 * own ~20-column `db.select({...})` literal and its own
 * `.from(runs).where(runByIdWhere(...)).limit(1)` → `rows[0] ?? null`
 * boilerplate. With no single source of truth the shapes drifted silently —
 * v1 returned `expectedTotalTests` while MCP (the surface built FOR agents)
 * didn't, and the summary route lacked `environment`/`repo`/`origin` — with
 * nothing marking the differences as intent. Now the shared core lives in
 * {@link RUN_SUMMARY_COLUMNS} and each surface's deliberate extras read as an
 * explicit `{ ...RUN_SUMMARY_COLUMNS, extra: runs.extra }` pick at the
 * surface, so divergence is visible as a named pick instead of drift.
 *
 * Deliberately NOT the other two run projections:
 *   - the runs-LIST/CSV shape (`RUN_COLUMNS` / `ExportedRun` in
 *     `@/lib/export.ts`) — the paginated list read-model;
 *   - the SSR page-props allowlist (`RUN_PUBLIC_COLUMNS` in
 *     `@/lib/runs/columns.ts`) — "every column except the `idempotencyKey`
 *     write credential", a security boundary, not a summary contract.
 */

/**
 * The shared BASE run-summary projection — the columns every by-id summary
 * surface agrees on: identity + status, VCS/CI context (branch, environment,
 * commit, PR, actor, repo, origin), the outcome counters, duration, and the
 * open/complete timestamps.
 *
 * Per-surface extras stay OUT of the base so the documented contracts are
 * pinned exactly where they're served:
 *   - `ciProvider` / `playwrightVersion` — MCP `get_run`'s agent-debugging
 *     extras (`MCP_RUN_COLUMNS` in `@/lib/mcp/queries`);
 *   - `expectedTotalTests` — the public v1 API's partial-suite detector
 *     (`routes/api/v1/runs/[runId]/index.ts`).
 * `idempotencyKey` (a write credential — see `RUN_PUBLIC_COLUMNS`) must never
 * join the base.
 */
export const RUN_SUMMARY_COLUMNS = {
  id: runs.id,
  status: runs.status,
  branch: runs.branch,
  environment: runs.environment,
  commitSha: runs.commitSha,
  commitMessage: runs.commitMessage,
  prNumber: runs.prNumber,
  actor: runs.actor,
  repo: runs.repo,
  origin: runs.origin,
  totalTests: runs.totalTests,
  passed: runs.passed,
  failed: runs.failed,
  flaky: runs.flaky,
  skipped: runs.skipped,
  durationMs: runs.durationMs,
  createdAt: runs.createdAt,
  completedAt: runs.completedAt,
} as const;

/** Any single column of the `runs` table, as a select-projection value. */
type RunsColumn =
  (typeof runs)["_"]["columns"][keyof (typeof runs)["_"]["columns"]];

/**
 * The result row a flat projection of `runs` columns produces — per key, the
 * column's data type with nullability applied. For a flat column projection
 * this is exactly what Drizzle's own select inference yields (`GetColumnData`
 * is the type Drizzle applies per selected column); it is stated explicitly
 * here because routing a *generic* projection through the select builder
 * leaves Drizzle's higher-kinded result types unreduced — they only collapse
 * for concrete selections. The `RunsColumn` constraint forbids SQL fragments,
 * aliases, and nested tables, so this mapping cannot diverge from the
 * builder's.
 */
export type RunRow<TColumns extends Record<string, RunsColumn>> = {
  [K in keyof TColumns]: GetColumnData<TColumns[K]>;
};

/**
 * Fetch ONE run's row by id within the tenant — the single home of the
 * `select(columns).from(runs).where(runByIdWhere(scope, runId)).limit(1)` →
 * `rows[0] ?? null` shape the three summary surfaces used to copy.
 *
 * Always scoped via the blessed `runByIdWhere(scope, runId)` predicate (never
 * a bare `eq(runs.id, …)`), so a run id belonging to another project simply
 * doesn't match — callers map the resulting `null` to their own 404 without
 * leaking existence. Presentation concerns (url building, cache headers,
 * serialization) stay at the surface; only the fetch + column source is
 * shared.
 *
 * `columns` is an explicit projection at every call site — typically
 * `RUN_SUMMARY_COLUMNS` or `{ ...RUN_SUMMARY_COLUMNS, extra: runs.extra }` —
 * so each surface's contract reads as intent.
 */
export async function loadRunColumns<
  TColumns extends Record<string, RunsColumn>,
>(
  scope: TenantScope,
  runId: string,
  columns: TColumns,
): Promise<RunRow<TColumns> | null> {
  // Widen to the concrete record type before handing to the builder — the
  // generic TColumns would leave the builder's result types unreduced (see
  // the RunRow doc above). Plain safe assignment, not an assertion.
  const projection: Record<string, RunsColumn> = columns;
  const rows = await db
    .select(projection)
    .from(runs)
    .where(runByIdWhere(scope, runId))
    .limit(1);
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- re-narrows the widened row back to the caller's projection; sound because the query selects exactly `columns` and RunRow mirrors Drizzle's per-column result mapping (see RunRow doc)
  return (rows[0] ?? null) as RunRow<TColumns> | null;
}
