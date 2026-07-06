import { and, asc, db, desc, eq, gt, inArray, lt, or, sql } from "void/db";
import { artifacts, runs, testResults } from "@schema";
import {
  type GroupByAxis,
  recommendedRank,
  type StatusFilterValue,
} from "@/lib/group-tests-by-file";
import { STATUS_BUCKET_MEMBERS, statusMatchSql } from "@/lib/ingest";
import {
  groupPredicate,
  statusFilterMembers,
  testSearchPredicate,
} from "@/lib/run-groups-page";
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
  /**
   * Populate `hasTrace` on each returned row (gates the per-row "Test Replay"
   * button on the run-detail Tests tab). One extra distinct-id query over the
   * page's test ids against `artifacts` — only the run-detail row page needs
   * it, so the v1 tests API and the CSV export leave it off. Absent ⇒ `hasTrace`
   * is omitted from the wire.
   */
  includeTraceFlags?: boolean;
}

/**
 * Decode an opaque base64 cursor of `${createdAt}:${id}` back into its
 * components. Returns `null` for any malformed input so callers degrade to
 * first-page (matches the legacy route's lenient behaviour).
 */
export function decodeCursor(
  raw: string | null,
): { createdAt: number; id: string } | null {
  if (!raw) return null;
  let decoded: string;
  try {
    decoded = atob(raw);
  } catch {
    return null;
  }
  const sep = decoded.indexOf(":");
  if (sep <= 0) return null;
  const createdAt = Number(decoded.slice(0, sep));
  const id = decoded.slice(sep + 1);
  if (!Number.isFinite(createdAt) || id.length === 0) return null;
  return { createdAt, id };
}

export function encodeCursor(createdAt: number, id: string): string {
  return btoa(`${createdAt}:${id}`);
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
  return btoa(`${rank}:${createdAt}:${id}`);
}

export function decodeRankedCursor(
  raw: string | null,
): { rank: number; createdAt: number; id: string } | null {
  if (!raw) return null;
  let decoded: string;
  try {
    decoded = atob(raw);
  } catch {
    return null;
  }
  const parts = decoded.split(":");
  if (parts.length < 3) return null;
  const rank = Number(parts[0]);
  const createdAt = Number(parts[1]);
  const id = parts.slice(2).join(":");
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

/**
 * Cursor-paginated fetch of testResults rows for a run, returned as
 * `RunProgressTest[]`. Default order is `(createdAt DESC, id DESC)`; the
 * `"recommended"` status bucket prepends a failed-before-flaky rank so its pages
 * stay coherent with the client's failed-first row sort (see the ordering block
 * below). The cursor is opaque base64 from the previous page's last row; invalid
 * cursors silently degrade to first-page (matches the legacy route).
 *
 * This is the one canonical definition of "a page of a run's testResults as
 * RunProgressTest[]": the GET /results API (per-group row pages + back-paginator),
 * the v1 tests API, and the CSV export loop all go through it, so the column
 * projection, ordering, scoping, and status normalization can never diverge.
 */
export async function loadRunResultsPage(
  scope: TenantScope,
  runId: string,
  opts: LoadRunResultsOpts,
): Promise<RunResultsResponse | null> {
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

  const orderBy = rankByBucket
    ? [asc(rankByBucket), desc(testResults.createdAt), desc(testResults.id)]
    : [desc(testResults.createdAt), desc(testResults.id)];

  const rows = await db
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
    .where(and(...conditions))
    .orderBy(...orderBy)
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  // Which of THIS page's tests have a trace → per-row "Test Replay" button.
  // Gated (only the run-detail row page asks) and scoped to the page's ids, so
  // it's one indexed distinct-id read (artifacts_testResultId_idx) per page.
  // Scoped by projectId like every child read; artifacts also carry runId but
  // the page ids already pin the rows to this run.
  let tracedIds: Set<string> | null = null;
  if (opts.includeTraceFlags && page.length > 0) {
    const traced = await db
      .selectDistinct({ testResultId: artifacts.testResultId })
      .from(artifacts)
      .where(
        and(
          eq(artifacts.projectId, scope.projectId),
          eq(artifacts.type, "trace"),
          inArray(
            artifacts.testResultId,
            page.map((r) => r.id),
          ),
        ),
      );
    tracedIds = new Set(traced.map((t) => t.testResultId));
  }

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
    results: page.map((r) => ({
      id: r.id,
      testId: r.testId,
      title: r.title,
      file: r.file,
      projectName: r.projectName,
      status: normalizeTestStatus(r.status),
      durationMs: r.durationMs,
      retryCount: r.retryCount,
      shardIndex: r.shardIndex,
      ...(tracedIds ? { hasTrace: tracedIds.has(r.id) } : {}),
    })),
    nextCursor,
  };
}
