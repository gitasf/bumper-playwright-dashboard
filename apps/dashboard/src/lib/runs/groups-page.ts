import { and, asc, db, desc, eq, isNull, or, sql } from "void/db";
import { runs, testResults } from "@schema";
import type { GroupByAxis, StatusFilterValue } from "@/lib/group-tests-by-file";
import { STATUS_BUCKET_MEMBERS, statusMatchSql } from "@/lib/ingest";
import { decodeKeyset, encodeKeyset } from "@/lib/keyset-cursor";
import { numericSql } from "@/lib/db/sql-ops";
import { escapeLike, likeEscaped } from "@/lib/runs/filters-where";
import { childByRunWhere, runByIdWhere, type TenantScope } from "@/lib/scope";

/** A non-null Drizzle SQL fragment (`void/db` doesn't export the `SQL` type). */
type SqlFragment = NonNullable<ReturnType<typeof and>>;

/**
 * Wire enums for the grouped read routes (`/groups` + `/results`), single-sourced
 * here so the two route validators can't drift. `satisfies` ties each to its
 * domain type (`GroupByAxis` / `StatusFilterValue`).
 */
export const GROUP_BY_AXES = [
  "file",
  "project",
  "shard",
] as const satisfies readonly GroupByAxis[];
export const STATUS_FILTER_VALUES = [
  "recommended",
  "failed",
  "flaky",
  "passed",
  "skipped",
] as const satisfies readonly StatusFilterValue[];

/**
 * The wire statuses a Tests-tab status filter matches, for `status IN (…)`.
 * `"recommended"` = the failed ∪ flaky buckets (the review-worthy tests); every
 * other value is its own bucket. The server counterpart of the client's
 * `matchesStatusFilter`, both deriving from `STATUS_BUCKET_MEMBERS` so they
 * can't drift.
 */
export function statusFilterMembers(
  value: StatusFilterValue,
): readonly string[] {
  if (value === "recommended") {
    return [...STATUS_BUCKET_MEMBERS.failed, ...STATUS_BUCKET_MEMBERS.flaky];
  }
  return STATUS_BUCKET_MEMBERS[value];
}

/**
 * Group headers per page. The list paginates by group (cursor below), so this
 * is a page size, not a hard cap — a monorepo with thousands of files loads them
 * in worst-first pages as the user scrolls the group list, never all at once and
 * never silently truncated. Worst-first ordering means page 1 carries every
 * failing group + the top passing ones, which is what a viewer wants first.
 */
export const DEFAULT_GROUP_PAGE_SIZE = 50;
const MAX_GROUP_PAGE_SIZE = 200;

/** Clamp a requested group-page size into `[1, MAX_GROUP_PAGE_SIZE]`. */
export function clampGroupLimit(limit: number): number {
  return Math.min(Math.max(1, limit), MAX_GROUP_PAGE_SIZE);
}

/**
 * Worst-first "damage" weights: a failed test dominates, a flaky one counts
 * half. Single-sourced here so the `ORDER BY` / `HAVING` SQL and the JS cursor
 * recompute below stay in lockstep — if they drifted, the keyset cursor would
 * stop matching the sort key and silently skip or repeat groups.
 */
const SEVERITY_FAILED_WEIGHT = 4;
const SEVERITY_FLAKY_WEIGHT = 2;

/** The `failed*4 + flaky*2` group severity in JS — mirror of the `severity` SQL. */
function groupSeverity(failed: number, flaky: number): number {
  return failed * SEVERITY_FAILED_WEIGHT + flaky * SEVERITY_FLAKY_WEIGHT;
}

/**
 * Opaque base64 cursor for group pagination: the last group's
 * `${severity}:${key}` under the `(severity DESC, key ASC)` ordering. Shares
 * the row cursor's wire codec (`keyset-cursor`); a `null` key encodes as the
 * empty string (the NULL fallback group). `null`/malformed → first page.
 */
export function encodeGroupCursor(
  severity: number,
  key: string | null,
): string {
  return encodeKeyset([String(severity), key ?? ""]);
}

function decodeGroupCursor(
  raw: string | null,
): { severity: number; key: string } | null {
  const segments = decodeKeyset(raw, 2);
  if (!segments) return null;
  const severity = Number(segments[0]);
  if (!Number.isFinite(severity)) return null;
  return { severity, key: segments[1] ?? "" };
}

/** One group's header: the raw axis value + its 4-bucket counts, worst-first. */
export interface RunGroupHeader {
  /**
   * The raw grouping value for the active axis — `file` string, `projectName`
   * (nullable), or `shardIndex` as a decimal string (nullable). `null` is the
   * axis's fallback group (empty projectName / non-sharded rows); the client
   * renders it as "default"/"Unsharded" and the row query maps it back to the
   * `IS NULL` predicate. For `file` (a NOT NULL column) an empty path reads as
   * the empty string, never `null`.
   */
  key: string | null;
  total: number;
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
  /**
   * Server-computed hint: this group is among the worst-N and carries a
   * failed/flaky-bucket test (or is the single worst group when none do), so
   * the client expands it on first paint. Boolean (not a key list) so the
   * `null` fallback group needs no special encoding on the wire.
   */
  expandedByDefault: boolean;
}

export interface RunGroupSkeleton {
  groupBy: GroupByAxis;
  /** Group headers for this page, worst-first (`failed*4 + flaky*2` desc, key asc). */
  groups: RunGroupHeader[];
  /** Cursor for the next page of groups, or `null` when this is the last page. */
  nextCursor: string | null;
  /**
   * Whether this page contains any failed/flaky-bucket group. The client's
   * one-shot auto-expand reads this off the first page to decide, on a run
   * watched live from empty, whether to latch yet (don't consume the latch on a
   * passing fallback — wait for a real failure). Computed here so the client
   * needn't re-derive the "is there a bad group" predicate the server already knows.
   */
  hasFailingGroup: boolean;
}

export interface LoadRunGroupsOpts {
  groupBy: GroupByAxis;
  /** Active status chip; `null`/`"all"` disables status filtering. */
  status: StatusFilterValue | null;
  /** Free-text needle matched against title + file (case-insensitive). */
  search: string | null;
  /** Opaque group cursor from the previous page; `null`/malformed → first page. */
  cursor: string | null;
  /** Group-page size (clamped to `[1, MAX_GROUP_PAGE_SIZE]`). */
  limit: number;
  /**
   * Skip the explicit run-exists probe when the caller has ALREADY resolved the
   * run's ownership itself (currently: test fixtures that seed `testResults`
   * rows without a `runs` control row). Every API route leaves this false so a
   * foreign/missing run 404s. This does NOT relax tenant scoping — the aggregate
   * always filters by `childByRunWhere` (projectId + runId), so even with the
   * probe skipped a foreign runId yields zero rows, never another tenant's data;
   * the only effect is an empty result instead of a 404.
   */
  skipOwnershipCheck?: boolean;
}

/** How many of the worst groups auto-expand (matches the SSR-seeded default). */
const AUTO_EXPAND_WINDOW = 6;

/** The `testResults` column backing each group-by axis. */
export function groupAxisColumn(axis: GroupByAxis) {
  if (axis === "file") return testResults.file;
  if (axis === "project") return testResults.projectName;
  return testResults.shardIndex;
}

/**
 * The WHERE predicate that scopes a row query to one group. `key === null`
 * selects the axis's fallback group: `IS NULL` for the nullable `projectName`
 * / `shardIndex` axes, and the empty-string file for the NOT NULL `file` axis.
 * The inverse of the client's `rawGroupKey` (which produces the skeleton `key`).
 */
export function groupPredicate(
  axis: GroupByAxis,
  key: string | null,
): SqlFragment {
  if (axis === "shard") {
    if (key === null) return isNull(testResults.shardIndex);
    const n = Number(key);
    return Number.isInteger(n)
      ? eq(testResults.shardIndex, n)
      : isNull(testResults.shardIndex);
  }
  if (axis === "project") {
    return key === null
      ? isNull(testResults.projectName)
      : eq(testResults.projectName, key);
  }
  // file is NOT NULL — a null key is the empty-path group, never IS NULL.
  return eq(testResults.file, key ?? "");
}

/** `(title ILIKE %q% OR file ILIKE %q%)` with wildcard-escaped needle, or null. */
export function testSearchPredicate(search: string | null): SqlFragment | null {
  const term = search?.trim();
  if (!term) return null;
  const pattern = `%${escapeLike(term)}%`;
  return (
    or(
      likeEscaped(testResults.title, pattern),
      likeEscaped(testResults.file, pattern),
    ) ?? null
  );
}

/** The `count(*) FILTER (WHERE status IN <bucket>)` fragment for one bucket. */
function bucketCount(bucket: keyof typeof STATUS_BUCKET_MEMBERS) {
  return numericSql(
    sql`count(*) filter (where ${statusMatchSql(STATUS_BUCKET_MEMBERS[bucket])})`,
  );
}

/**
 * The "group skeleton" for a run's Tests tab: one worst-first-ordered header
 * per group (file / Playwright project / shard) with its 4-bucket counts,
 * computed by a single `GROUP BY <axis>` over the run's rows. The counts reuse
 * `STATUS_BUCKET_MEMBERS` / `statusMatchSql` verbatim so they can never drift
 * from the run-level aggregate (`aggregateRecomputeStatement`) the filter chips
 * read. Rides `testResults_project_runId_idx` (projectId, runId): the seek
 * narrows to one run's partition, then a HashAggregate collapses it to the
 * (small) group set — no group-column index needed at current scale.
 *
 * This is the read seam a materialized rollup would slot behind unchanged: same
 * signature, same `RunGroupSkeleton` shape.
 */
export async function loadRunGroupSkeleton(
  scope: TenantScope,
  runId: string,
  opts: LoadRunGroupsOpts,
): Promise<RunGroupSkeleton | null> {
  if (!opts.skipOwnershipCheck) {
    const owner = await db
      .select({ id: runs.id })
      .from(runs)
      .where(runByIdWhere(scope, runId))
      .limit(1);
    if (!owner[0]) return null;
  }

  const axisCol = groupAxisColumn(opts.groupBy);
  const conditions: SqlFragment[] = [
    childByRunWhere(testResults, scope, runId),
  ];
  if (opts.status) {
    conditions.push(statusMatchSql(statusFilterMembers(opts.status)));
  }
  const search = testSearchPredicate(opts.search);
  if (search) conditions.push(search);

  // Worst-first group ordering, owned by the server: damage weight
  // failed*4 + flaky*2 (failed/flaky are the bucketed counts, so timedout ∈
  // failed), desc; the group key breaks ties (asc) for a stable, deterministic
  // order. This is the authoritative display order — the client renders the
  // skeleton verbatim, it does not re-sort groups.
  const severity = sql`count(*) filter (where ${statusMatchSql(
    STATUS_BUCKET_MEMBERS.failed,
  )}) * ${sql.raw(String(SEVERITY_FAILED_WEIGHT))} + count(*) filter (where ${statusMatchSql(
    STATUS_BUCKET_MEMBERS.flaky,
  )}) * ${sql.raw(String(SEVERITY_FLAKY_WEIGHT))}`;

  // Keyset pagination on `(severity DESC, key ASC NULLS LAST)` via HAVING (the
  // cursor references the aggregate, which WHERE can't). The key tiebreak must
  // match the ORDER BY's native type comparison and NULLS-LAST placement, so
  // it's built per axis rather than a blanket `::text` cast: on the integer
  // `shard` axis a text cast diverges from numeric order (e.g. "10" < "9" as
  // text, dropping shard 10 right after a cursor at shard 9), and a plain `>`
  // comparison never matches the NULL fallback group (`NULL > x` is NULL).
  const cursor = decodeGroupCursor(opts.cursor);
  const axisIsNumeric = opts.groupBy === "shard";
  let having: SqlFragment | undefined;
  if (cursor) {
    if (cursor.key === "") {
      // Cursor sits on the NULL fallback group, which under `asc(axisCol)`
      // (NULLS LAST) sorts after every non-null key in its tier — nothing else
      // remains in that tier, so only lower-severity tiers continue.
      having = sql`(${severity}) < ${cursor.severity}`;
    } else {
      const numericKey = Number(cursor.key);
      const keyCompare =
        axisIsNumeric && Number.isFinite(numericKey)
          ? sql`${axisCol} > ${numericKey}`
          : axisIsNumeric
            ? // Malformed numeric key (shouldn't happen via our encoder) — fail
              // closed; comparing an integer column to a text bind errors in pg.
              sql`false`
            : sql`${axisCol} > ${cursor.key}`;
      // Continue the tier at the next key (native compare, matching
      // `ORDER BY asc(axisCol)`) or the NULL fallback group, which sorts after
      // every non-null key in the tier (NULLS LAST) and must stay visible.
      having = sql`(${severity}) < ${cursor.severity} or ((${severity}) = ${cursor.severity} and ((${keyCompare}) or (${axisCol} is null)))`;
    }
  }

  const limit = clampGroupLimit(opts.limit);
  const rows = await db
    .select({
      key: axisCol,
      total: numericSql(sql`count(*)`),
      passed: bucketCount("passed"),
      failed: bucketCount("failed"),
      flaky: bucketCount("flaky"),
      skipped: bucketCount("skipped"),
    })
    .from(testResults)
    .where(and(...conditions))
    .groupBy(axisCol)
    .having(having)
    .orderBy(desc(severity), asc(axisCol))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  // Auto-expand hints apply ONLY to the first page (initial paint) — the
  // worst-N groups that carry a failed/flaky test, or the single worst group as
  // a fallback so the list is never fully collapsed. Later pages (loaded on
  // scroll) never carry hints; the client's one-shot latch reads only page 1,
  // so this keeps the wire honest. `page` is already worst-first.
  const expandedIdx = new Set<number>();
  if (!cursor) {
    for (let i = 0; i < Math.min(AUTO_EXPAND_WINDOW, page.length); i++) {
      const r = page[i];
      if (r && (r.failed > 0 || r.flaky > 0)) expandedIdx.add(i);
    }
    if (expandedIdx.size === 0 && page.length > 0) expandedIdx.add(0);
  }

  const groups: RunGroupHeader[] = page.map((r, i) => ({
    // Normalize the raw value to `string | null`: shardIndex is a number.
    key: r.key === null ? null : String(r.key),
    total: r.total,
    passed: r.passed,
    failed: r.failed,
    flaky: r.flaky,
    skipped: r.skipped,
    expandedByDefault: expandedIdx.has(i),
  }));

  const last = page.at(-1);
  const nextCursor =
    hasMore && last
      ? encodeGroupCursor(
          groupSeverity(last.failed, last.flaky),
          groups.at(-1)?.key ?? null,
        )
      : null;

  // Worst-first ordering means any failing group sorts to the top, so a single
  // scan of the page answers the client's "is there a bad group here" question.
  const hasFailingGroup = page.some((r) => r.failed > 0 || r.flaky > 0);

  return { groupBy: opts.groupBy, groups, nextCursor, hasFailingGroup };
}
