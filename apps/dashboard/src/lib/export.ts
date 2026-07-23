import { and, db, desc, eq, lt, or } from "void/db";
import { logger } from "void/log";
import { runs } from "@schema";
import { type CsvValue, csvRow } from "@/lib/csv";
import {
  decodeCursor,
  encodeCursor,
  loadRunResultsPage,
} from "@/lib/runs/results-page";
import type { RunsFilters } from "@/lib/runs/filters";
import { scopedRunsWhere } from "@/lib/runs/filters-where";
import { runByIdWhere, type TenantScope } from "@/lib/scope";

/**
 * Shared query + CSV-shape layer for the data-export / public-query surface
 * (roadmap 2.5). The ONE place the runs-list query, the per-run tests query, and
 * the CSV column definitions live — consumed identically by:
 *
 *   - the Bearer-authed public API (`routes/api/v1/*`), and
 *   - the session-authed in-dashboard export (`routes/api/t/.../export/*`).
 *
 * Both surfaces hand in an already-auth-checked `TenantScope`; every query here
 * is scoped by it (`scopedRunsWhere` / `runByIdWhere` / `loadRunResultsPage`),
 * so a project-A key/session can never read project-B rows. No raw string ids
 * cross this boundary — the brand keeps it honest.
 */

/**
 * Per-DB-page size for the cursor walk. Distinct from the user-facing
 * `WRIGHTFUL_EXPORT_MAX_ROWS` cap (env): that bounds the TOTAL rows a single
 * export emits; this bounds each round-trip. 500 keeps a page's bound-param
 * footprint and memory modest while minimizing round-trips on a large export.
 */
export const EXPORT_PAGE_SIZE = 500;

/**
 * Hard ceiling on the in-memory CSV cap, independent of the env knob. The whole
 * document is assembled as one string, so this bounds isolate memory even if an
 * operator sets `WRIGHTFUL_EXPORT_MAX_ROWS` to something pathological (the env
 * builder has no `.max`). 200k rows × a handful of short columns is tens of MB —
 * still within a Worker's budget. `resolveExportCap` clamps to `[1, this]`.
 */
export const EXPORT_HARD_MAX_ROWS = 200_000;

/** Clamp a configured row cap to a sane, memory-safe `[1, EXPORT_HARD_MAX_ROWS]`. */
export function resolveExportCap(configured: number): number {
  if (!Number.isFinite(configured)) return EXPORT_HARD_MAX_ROWS;
  return Math.min(Math.max(1, Math.floor(configured)), EXPORT_HARD_MAX_ROWS);
}

/** Max rows a single JSON list page returns (cursor-paged). */
export const DEFAULT_RUNS_LIST_LIMIT = 50;
export const MAX_RUNS_LIST_LIMIT = 200;

// ─── Runs list (JSON + cursor) ───────────────────────────────────────────────

/** A run row as returned by the public list/export — the stable column set. */
export interface ExportedRun {
  id: string;
  status: string;
  branch: string | null;
  environment: string | null;
  commitSha: string | null;
  commitMessage: string | null;
  prNumber: number | null;
  actor: string | null;
  repo: string | null;
  origin: string;
  totalTests: number;
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
  durationMs: number;
  createdAt: number;
  completedAt: number | null;
}

export interface RunsListPage {
  runs: ExportedRun[];
  nextCursor: string | null;
}

/** The explicit column projection — shared by the JSON select and the cursor walk. */
const RUN_COLUMNS = {
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

/** Clamp a requested list page size into `[1, MAX_RUNS_LIST_LIMIT]`. */
export function clampRunsListLimit(limit: number): number {
  return Math.min(Math.max(1, limit), MAX_RUNS_LIST_LIMIT);
}

/**
 * Build the WHERE fragment for a runs page: tenant scope + filter bar +
 * (optional) the strict `(createdAt, id) < cursor` tuple for DESC pagination.
 *
 * Factored out (not inlined) so a unit test can assert it is ALWAYS
 * projectId/teamId-scoped via `scopedRunsWhere` (mirrors `run-diff.test.ts`'s
 * void/db-stub idiom). Cursor params are bound — never interpolated.
 */
export function buildRunsPageWhere(
  scope: TenantScope,
  filters: RunsFilters,
  cursor: { createdAt: number; id: string } | null,
) {
  const scoped = scopedRunsWhere(scope, filters);
  if (!cursor) return scoped;
  // Strict tuple comparison (createdAt, id) < (cursor.createdAt, cursor.id),
  // materialized as an OR so SQLite's planner can use the createdAt index then
  // tiebreak on the ULID id. Identical shape to loadRunResultsPage.
  const tuple = or(
    lt(runs.createdAt, cursor.createdAt),
    and(eq(runs.createdAt, cursor.createdAt), lt(runs.id, cursor.id)),
  );
  return tuple ? and(scoped, tuple)! : scoped;
}

/**
 * One cursor-paginated page of runs, project-scoped + filtered. Order is
 * `(createdAt DESC, id DESC)`; the cursor is the opaque base64 of
 * `${createdAt}:${id}` from the previous page's last row (the SAME codec as
 * `loadRunResultsPage`). Invalid cursors degrade to first-page.
 */
export async function loadRunsListPage(
  scope: TenantScope,
  filters: RunsFilters,
  opts: { cursor: string | null; limit: number },
): Promise<RunsListPage> {
  const limit = clampRunsListLimit(opts.limit);
  const cursor = decodeCursor(opts.cursor);

  const rows = await db
    .select(RUN_COLUMNS)
    .from(runs)
    .where(buildRunsPageWhere(scope, filters, cursor))
    .orderBy(desc(runs.createdAt), desc(runs.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);
  const nextCursor =
    hasMore && last ? encodeCursor(last.createdAt, last.id) : null;

  return { runs: page, nextCursor };
}

// ─── CSV shapes ──────────────────────────────────────────────────────────────

/**
 * Column order for a runs CSV export. The header AND the row mapper are kept
 * adjacent so they can't drift — `runCsvCells(run)` returns cells in exactly
 * this order. Documented in `docs/worklog`/`docs/api` and the in-app docs page.
 */
export const RUN_CSV_HEADER = [
  "id",
  "status",
  "branch",
  "environment",
  "commit_sha",
  "commit_message",
  "pr_number",
  "actor",
  "repo",
  "origin",
  "total_tests",
  "passed",
  "failed",
  "flaky",
  "skipped",
  "duration_ms",
  "created_at",
  "completed_at",
] as const;

export function runCsvCells(run: ExportedRun): CsvValue[] {
  return [
    run.id,
    run.status,
    run.branch,
    run.environment,
    run.commitSha,
    run.commitMessage,
    run.prNumber,
    run.actor,
    run.repo,
    run.origin,
    run.totalTests,
    run.passed,
    run.failed,
    run.flaky,
    run.skipped,
    run.durationMs,
    run.createdAt,
    run.completedAt,
  ];
}

/** Column order for a per-run test-results CSV export. */
export const TEST_CSV_HEADER = [
  "id",
  "test_id",
  "title",
  "file",
  "project_name",
  "status",
  "duration_ms",
  "retry_count",
] as const;

/** A test row as returned by `loadRunResultsPage` (`RunProgressTest`). */
interface ExportedTest {
  id: string;
  testId: string;
  title: string;
  file: string;
  projectName: string | null;
  status: string;
  durationMs: number;
  retryCount: number;
}

export function testCsvCells(t: ExportedTest): CsvValue[] {
  return [
    t.id,
    t.testId,
    t.title,
    t.file,
    t.projectName,
    t.status,
    t.durationMs,
    t.retryCount,
  ];
}

// ─── Streaming CSV builders (cursor-paged, capped) ──────────────────────────

export interface CsvExportResult {
  /** The full CSV document (header + body rows, all CRLF-terminated). */
  body: string;
  /** Total body rows written (excludes the header). */
  rowCount: number;
  /** True when the `maxRows` cap stopped the walk before exhausting the data. */
  truncated: boolean;
}

/**
 * Page through ALL runs matching `filters` (project-scoped) and serialize them
 * to a CSV document, stopping at `maxRows` (`WRIGHTFUL_EXPORT_MAX_ROWS`). Reuses
 * the SAME `loadRunsListPage` cursor walk as the JSON API, so the export and the
 * paged API can never diverge in scope or ordering.
 *
 * The cap is NOT silent: `truncated` is surfaced so the route can set
 * `X-Wrightful-Export-Truncated` and log. The body is assembled in memory — the
 * `maxRows` cap is what keeps that bounded (50k rows × a handful of short
 * columns is a few MB, comfortably within a Worker response).
 */
export async function buildRunsCsv(
  scope: TenantScope,
  filters: RunsFilters,
  maxRowsConfigured: number,
): Promise<CsvExportResult> {
  const maxRows = resolveExportCap(maxRowsConfigured);
  let body = csvRow(RUN_CSV_HEADER) + "\r\n";
  let rowCount = 0;
  let cursor: string | null = null;
  let truncated = false;

  for (;;) {
    const remaining = maxRows - rowCount;
    if (remaining <= 0) {
      // We've already written maxRows; check whether more exist to flag truncation.
      const probe = await loadRunsListPage(scope, filters, {
        cursor,
        limit: 1,
      });
      truncated = probe.runs.length > 0;
      break;
    }
    const limit = Math.min(EXPORT_PAGE_SIZE, remaining);
    const page = await loadRunsListPage(scope, filters, { cursor, limit });
    for (const run of page.runs) {
      body += csvRow(runCsvCells(run)) + "\r\n";
      rowCount += 1;
    }
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }

  return { body, rowCount, truncated };
}

/**
 * Page through ALL test results for a single run (project-scoped, validated via
 * `loadRunResultsPage`'s `runByIdWhere` ownership check) and serialize to CSV,
 * capped at `maxRows`. Returns `null` if the run doesn't belong to the scope's
 * project (→ caller maps to 404), distinguishing "no such run" from "empty run".
 */
export async function buildRunTestsCsv(
  scope: TenantScope,
  runId: string,
  maxRowsConfigured: number,
): Promise<CsvExportResult | null> {
  const maxRows = resolveExportCap(maxRowsConfigured);
  // Ownership probe via the canonical (projectId, runId) predicate. A miss is a
  // 404 — never leak another project's run id.
  const owner = await db
    .select({ id: runs.id })
    .from(runs)
    .where(runByIdWhere(scope, runId))
    .limit(1);
  if (!owner[0]) return null;

  let body = csvRow(TEST_CSV_HEADER) + "\r\n";
  let rowCount = 0;
  let cursor: string | null = null;
  let truncated = false;

  for (;;) {
    const remaining = maxRows - rowCount;
    if (remaining <= 0) {
      const probe = await loadRunResultsPage(scope, runId, {
        cursor,
        limit: 1,
        status: null,
        skipOwnershipCheck: true,
      });
      truncated = (probe?.results.length ?? 0) > 0;
      break;
    }
    const limit = Math.min(EXPORT_PAGE_SIZE, remaining);
    // Ownership was confirmed by the up-front probe above, so skip the per-page
    // re-probe (this loop can run many pages) — `page` is always non-null here.
    const page = await loadRunResultsPage(scope, runId, {
      cursor,
      limit,
      status: null,
      skipOwnershipCheck: true,
    });
    if (!page) break;
    for (const t of page.results) {
      body += csvRow(testCsvCells(t)) + "\r\n";
      rowCount += 1;
    }
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }

  return { body, rowCount, truncated };
}

// ─── Response helpers ────────────────────────────────────────────────────────

/**
 * Sanitize a slug fragment for use inside a `Content-Disposition` filename.
 * Keeps `[A-Za-z0-9._-]`, collapses everything else to `-`. Filenames are
 * derived from already-validated slugs, but this is belt-and-braces so a header
 * is never injected with CR/LF/quote.
 */
export function safeFilenamePart(s: string): string {
  return (
    s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "export"
  );
}

/** Build the standard CSV response headers for an export. */
export function csvHeaders(filename: string, truncated: boolean): HeadersInit {
  const headers: Record<string, string> = {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="${safeFilenamePart(filename)}.csv"`,
    "cache-control": "private, no-store",
  };
  if (truncated) headers["x-wrightful-export-truncated"] = "true";
  return headers;
}

/**
 * The one CSV-attachment response constructor for the export routes (public
 * `?format=csv` + the in-dashboard export): truncation warn-log, the
 * `${teamSlug}-${projectSlug}-…` filename derivation (sanitized via
 * {@link csvHeaders}), and `Response` assembly, previously copy-pasted per
 * route. Routes stay translation-only: build the CSV (their own `null` → 404),
 * then hand the result here. `maxRows` is received rather than read from env so
 * this module stays env-free; it appears only in the truncation log.
 */
export function csvExportResponse(opts: {
  scope: TenantScope;
  csv: CsvExportResult;
  /** Filename becomes `${teamSlug}-${projectSlug}-${filenameSuffix}.csv`. */
  filenameSuffix: string;
  /** Warn-log message emitted only when the row cap truncated the export. */
  logMessage: string;
  /** The configured (unclamped) row cap, for the truncation log. */
  maxRows: number;
  /** Extra structured fields for the truncation log (e.g. `{ runId }`). */
  logFields?: Record<string, unknown>;
}): Response {
  const { scope, csv } = opts;
  if (csv.truncated) {
    logger.warn(opts.logMessage, {
      projectId: scope.projectId,
      ...opts.logFields,
      maxRows: opts.maxRows,
      rowCount: csv.rowCount,
    });
  }
  const filename = `${scope.teamSlug}-${scope.projectSlug}-${opts.filenameSuffix}`;
  return new Response(csv.body, {
    headers: csvHeaders(filename, csv.truncated),
  });
}
