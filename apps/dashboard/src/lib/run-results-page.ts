import { and, db, desc, eq, lt, or } from "void/db";
import { runs, testResults } from "@schema";
import { runByIdWhere, type TenantScope } from "@/lib/scope";
import type { RunProgressTest } from "@/lib/live-client";

export const DEFAULT_RUN_RESULTS_LIMIT = 200;
export const MAX_RUN_RESULTS_LIMIT = 500;

export interface RunResultsResponse {
  results: RunProgressTest[];
  nextCursor: string | null;
}

export interface LoadRunResultsOpts {
  cursor: string | null;
  limit: number;
  status: string | null;
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
 * Clamp a requested page size into the `[1, MAX_RUN_RESULTS_LIMIT]` range.
 */
export function clampRunResultsLimit(limit: number): number {
  return Math.min(Math.max(1, limit), MAX_RUN_RESULTS_LIMIT);
}

/**
 * Coerce a raw `testResults.status` string into the closed set the live
 * client renders. Unknown values fall back to `queued` so the SSR seed and
 * the paginated pages agree on shape.
 */
export function normalizeTestStatus(s: string): RunProgressTest["status"] {
  if (
    s === "passed" ||
    s === "failed" ||
    s === "flaky" ||
    s === "skipped" ||
    s === "timedout" ||
    s === "queued"
  ) {
    return s;
  }
  return "queued";
}

/**
 * Cursor-paginated fetch of testResults rows for a run, returned as
 * `RunProgressTest[]`. Order is `(createdAt DESC, id DESC)` — cursor is opaque
 * base64 of `${createdAt}:${id}` from the previous page's last row. Invalid
 * cursors silently degrade to first-page (matches the legacy route).
 *
 * This is the one canonical definition of "first page of a run's testResults
 * as RunProgressTest[]": both the GET /results API (back-paginator) and the
 * run-detail page loader (SSR seed for `useRunProgress`) go through it, so the
 * 11-column projection, ordering, scoping, and status normalization can never
 * diverge between the seed and later pages.
 */
export async function loadRunResultsPage(
  scope: TenantScope,
  runId: string,
  opts: LoadRunResultsOpts,
): Promise<RunResultsResponse | null> {
  // Confirm the run belongs to this project.
  const owner = await db
    .select({ id: runs.id })
    .from(runs)
    .where(runByIdWhere(scope, runId))
    .limit(1);
  if (!owner[0]) return null;

  const limit = clampRunResultsLimit(opts.limit);

  const conditions = [
    eq(testResults.projectId, scope.projectId),
    eq(testResults.runId, runId),
  ];
  if (opts.status) {
    conditions.push(eq(testResults.status, opts.status));
  }
  const cursor = decodeCursor(opts.cursor);
  if (cursor) {
    // Strict tuple comparison (createdAt, id) < (cursor.createdAt, cursor.id)
    // for DESC pagination. Materialized as an OR so SQLite's planner can use
    // the (createdAt, id) ordering directly.
    const tupleClause = or(
      lt(testResults.createdAt, cursor.createdAt),
      and(
        eq(testResults.createdAt, cursor.createdAt),
        lt(testResults.id, cursor.id),
      ),
    );
    if (tupleClause) conditions.push(tupleClause);
  }

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
      errorMessage: testResults.errorMessage,
      errorStack: testResults.errorStack,
      createdAt: testResults.createdAt,
    })
    .from(testResults)
    .where(and(...conditions))
    .orderBy(desc(testResults.createdAt), desc(testResults.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);
  const nextCursor =
    hasMore && last ? encodeCursor(last.createdAt, last.id) : null;

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
      errorMessage: r.errorMessage,
      errorStack: r.errorStack,
    })),
    nextCursor,
  };
}
