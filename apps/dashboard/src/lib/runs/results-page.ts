import { and, asc, db, desc, eq, gt, lt, or, sql } from "void/db";
import { runs, testResults } from "@schema";
import {
  type GroupByAxis,
  recommendedRank,
  type StatusFilterValue,
} from "@/lib/group-tests-by-file";
import { STATUS_BUCKET_MEMBERS, statusMatchSql } from "@/lib/ingest";
import { decodeKeyset, encodeKeyset } from "@/lib/keyset-cursor";
import {
  groupPredicate,
  statusFilterMembers,
  testSearchPredicate,
} from "@/lib/runs/groups-page";
import { childByRunWhere, runByIdWhere, type TenantScope } from "@/lib/scope";
import type { RunProgressTest } from "@/realtime/run-progress";

export const DEFAULT_RUN_RESULTS_LIMIT = 200;
export const MAX_RUN_RESULTS_LIMIT = 500;

export interface RunResultsResponse {
  results: RunProgressTest[];
  nextCursor: string | null;
}

export interface LoadRunResultsOpts {
  cursor: string | null;
  limit: number;
  /** Raw single-status filter (legacy GET /results `?status=` param). */
  status: string | null;
  /**
   * Filter to a Tests-tab status chip — `"failed"` matches `failed`+`timedout`,
   * `"recommended"` matches failed ∪ flaky, etc. (`statusFilterMembers`), so a
   * group's row page agrees with the skeleton's counts. `null`/`"all"` disables
   * it. Distinct from the raw `status` above (a single wire status).
   */
  statusBucket?: StatusFilterValue | null;
  /**
   * Restrict to one group of the Tests-tab grouping axis (the per-group row
   * page behind an expanded group). `key === null` selects the axis's fallback
   * group — see `groupPredicate`. Omit for the ungrouped/back-paginator path.
   */
  group?: { axis: GroupByAxis; key: string | null } | null;
  /** Free-text needle matched against title + file (case-insensitive). */
  search?: string | null;
  /**
   * Skip the run-ownership probe when the caller has ALREADY confirmed the run
   * belongs to the scope. Every API route leaves this false; the CSV export loop
   * (`buildRunTestsCsv`) sets it after its own up-front probe (so its N page
   * reads don't each re-probe), and test fixtures set it to read rows seeded
   * without a `runs` control row. Never relaxes tenant scoping — `childByRunWhere`
   * still filters every read by projectId + runId.
   */
  skipOwnershipCheck?: boolean;
}

/**
 * Decode an opaque base64 cursor of `${createdAt}:${id}` back into its
 * components. Returns `null` for any malformed input so callers degrade to
 * first-page (matches the legacy route's lenient behaviour). Wire codec is
 * the shared `keyset-cursor` one; numeric coercion + non-empty id stay here.
 */
export function decodeCursor(
  raw: string | null,
): { createdAt: number; id: string } | null {
  const segments = decodeKeyset(raw, 2);
  if (!segments) return null;
  const createdAt = Number(segments[0]);
  const id = segments[1] ?? "";
  if (!Number.isFinite(createdAt) || id.length === 0) return null;
  return { createdAt, id };
}

export function encodeCursor(createdAt: number, id: string): string {
  return encodeKeyset([String(createdAt), id]);
}

/**
 * The `"recommended"` view orders rows failed-before-flaky — a leading bucket
 * rank (failed = 0, flaky = 1) then `(createdAt DESC, id DESC)` — so its keyset
 * cursor carries that rank as a leading segment: `${rank}:${createdAt}:${id}`.
 * Kept separate from {@link decodeCursor} (the 2-tuple every other view uses)
 * because the arities differ; `loadRunResultsPage` picks the codec by query mode.
 */
export function encodeRankedCursor(
  rank: number,
  createdAt: number,
  id: string,
): string {
  return encodeKeyset([String(rank), String(createdAt), id]);
}

export function decodeRankedCursor(
  raw: string | null,
): { rank: number; createdAt: number; id: string } | null {
  const segments = decodeKeyset(raw, 3);
  if (!segments) return null;
  const rank = Number(segments[0]);
  const createdAt = Number(segments[1]);
  const id = segments[2] ?? "";
  if (
    !Number.isFinite(rank) ||
    !Number.isFinite(createdAt) ||
    id.length === 0
  ) {
    return null;
  }
  return { rank, createdAt, id };
}

/**
 * Clamp a requested page size into the `[1, MAX_RUN_RESULTS_LIMIT]` range.
 */
export function clampRunResultsLimit(limit: number): number {
  return Math.min(Math.max(1, limit), MAX_RUN_RESULTS_LIMIT);
}

/** The closed set the live client renders, as one typed list (no casts). */
const TEST_STATUSES: readonly RunProgressTest["status"][] = [
  "passed",
  "failed",
  "flaky",
  "skipped",
  "timedout",
  "queued",
];

/**
 * Coerce a raw `testResults.status` string into the closed set the live
 * client renders. Unknown values fall back to `queued` so the SSR seed and
 * the paginated pages agree on shape.
 */
export function normalizeTestStatus(s: string): RunProgressTest["status"] {
  return TEST_STATUSES.find((status) => status === s) ?? "queued";
}

/** A non-undefined Drizzle WHERE fragment, suitable for `.where(...)`. */
type SqlFragment = NonNullable<ReturnType<typeof and>>;

/** The canonical `(createdAt, id)` DESC ordering every run-tests page shares. */
export function runTestsOrderBy() {
  return [desc(testResults.createdAt), desc(testResults.id)] as const;
}

/** ORDER BY fragments chosen by the engine (rank-aware for "recommended"). */
type RunTestsOrderBy = readonly ReturnType<typeof desc>[];

/**
 * The one cursor-paginated read over a run's `testResults`: owner probe,
 * status/bucket/group/search WHERE composition, the ordering, and the
 * `hasMore → nextCursor` unwrap — all live HERE, once. Callers supply only the
 * column projection (`fetchRows`, which owns its own typed `db.select` and
 * applies the engine-chosen `orderBy`) and a row mapper, so a projection that
 * carries extra columns (the MCP surface's `errorMessage`) reuses the exact
 * pagination contract instead of forking it. `Row` must expose `id`,
 * `createdAt` + `status` so the shared cursor can be minted from any
 * projection.
 *
 * Default order is `(createdAt DESC, id DESC)`; the `"recommended"` status
 * bucket prepends a failed-before-flaky rank so its pages stay coherent with
 * the client's failed-first row sort (see the ordering block below) — both the
 * ORDER BY and the keyset cursor carry the rank. Returns `null` when the run
 * isn't in scope; invalid cursors silently degrade to first-page (matches the
 * legacy route).
 */
export async function paginateRunTests<
  Row extends { id: string; createdAt: number; status: string },
  Out,
>(
  scope: TenantScope,
  runId: string,
  opts: LoadRunResultsOpts,
  fetchRows: (
    where: SqlFragment,
    orderBy: RunTestsOrderBy,
    limit: number,
  ) => Promise<Row[]>,
  mapRow: (row: Row) => Out,
): Promise<{ items: Out[]; nextCursor: string | null } | null> {
  // Confirm the run belongs to this project.
  if (!opts.skipOwnershipCheck) {
    const owner = await db
      .select({ id: runs.id })
      .from(runs)
      .where(runByIdWhere(scope, runId))
      .limit(1);
    if (!owner[0]) return null;
  }

  const limit = clampRunResultsLimit(opts.limit);

  const conditions = [childByRunWhere(testResults, scope, runId)];
  if (opts.status) {
    conditions.push(eq(testResults.status, opts.status));
  }
  if (opts.statusBucket) {
    conditions.push(statusMatchSql(statusFilterMembers(opts.statusBucket)));
  }
  if (opts.group) {
    conditions.push(groupPredicate(opts.group.axis, opts.group.key));
  }
  const search = testSearchPredicate(opts.search ?? null);
  if (search) conditions.push(search);

  // The "recommended" view (failed ∪ flaky) orders failed-before-flaky via a
  // leading bucket rank (failed = 0, flaky = 1). Without it the query orders
  // purely by (createdAt, id) while the client sorts failed-first, so page 2's
  // older failed rows would land ABOVE page 1's flaky rows already on screen.
  // Both the ORDER BY and the keyset cursor carry the rank, so pagination can't
  // skip a newer flaky row that sorts after an older failed one.
  const rankByBucket =
    opts.statusBucket === "recommended"
      ? sql<number>`case when ${statusMatchSql(STATUS_BUCKET_MEMBERS.failed)} then 0 else 1 end`
      : null;

  if (rankByBucket) {
    const cursor = decodeRankedCursor(opts.cursor);
    if (cursor) {
      // Strict (rank ASC, createdAt DESC, id DESC) > cursor.
      const clause = or(
        gt(rankByBucket, cursor.rank),
        and(
          eq(rankByBucket, cursor.rank),
          or(
            lt(testResults.createdAt, cursor.createdAt),
            and(
              eq(testResults.createdAt, cursor.createdAt),
              lt(testResults.id, cursor.id),
            ),
          ),
        ),
      );
      if (clause) conditions.push(clause);
    }
  } else {
    const cursor = decodeCursor(opts.cursor);
    if (cursor) {
      // Strict tuple comparison (createdAt, id) < (cursor.createdAt, cursor.id)
      // for DESC pagination. Materialized as an OR so the planner can use the
      // (createdAt, id) ordering directly.
      const tupleClause = or(
        lt(testResults.createdAt, cursor.createdAt),
        and(
          eq(testResults.createdAt, cursor.createdAt),
          lt(testResults.id, cursor.id),
        ),
      );
      if (tupleClause) conditions.push(tupleClause);
    }
  }

  const orderBy: RunTestsOrderBy = rankByBucket
    ? [asc(rankByBucket), ...runTestsOrderBy()]
    : runTestsOrderBy();

  const rows = await fetchRows(and(...conditions)!, orderBy, limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);
  const nextCursor =
    hasMore && last
      ? rankByBucket
        ? encodeRankedCursor(
            recommendedRank(last.status),
            last.createdAt,
            last.id,
          )
        : encodeCursor(last.createdAt, last.id)
      : null;

  return {
    items: page.map(mapRow),
    nextCursor,
  };
}

/**
 * The one canonical definition of "a page of a run's testResults as
 * `RunProgressTest[]`": the GET /results API (per-group row pages +
 * back-paginator), the run-detail page loader (SSR seed for `useRunRoom`),
 * the v1 tests API, and the CSV export loop all go through it. The MCP
 * `list_tests` tool shares the same `paginateRunTests` engine with a wider
 * projection (see `loadMcpRunTests`), so scoping, ordering, and the cursor
 * contract can never drift between surfaces.
 */
export async function loadRunResultsPage(
  scope: TenantScope,
  runId: string,
  opts: LoadRunResultsOpts,
): Promise<RunResultsResponse | null> {
  const page = await paginateRunTests(
    scope,
    runId,
    opts,
    (where, orderBy, limit) =>
      db
        .select({
          id: testResults.id,
          testId: testResults.testId,
          title: testResults.title,
          file: testResults.file,
          projectName: testResults.projectName,
          status: testResults.status,
          durationMs: testResults.durationMs,
          retryCount: testResults.retryCount,
          shardIndex: testResults.shardIndex,
          createdAt: testResults.createdAt,
        })
        .from(testResults)
        .where(where)
        .orderBy(...orderBy)
        .limit(limit),
    (r) => ({
      id: r.id,
      testId: r.testId,
      title: r.title,
      file: r.file,
      projectName: r.projectName,
      status: normalizeTestStatus(r.status),
      durationMs: r.durationMs,
      retryCount: r.retryCount,
      shardIndex: r.shardIndex,
    }),
  );
  if (!page) return null;
  return { results: page.items, nextCursor: page.nextCursor };
}
