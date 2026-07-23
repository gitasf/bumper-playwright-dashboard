import { defer, defineHandler, type InferProps } from "void";
import { sql } from "void/db";
import { loadProjectBranches } from "@/lib/branches-query";
import { loadProjectTags } from "@/lib/tags-query";
import { runRows } from "@/lib/runs/db";
import { intAggExpr, numAggExpr } from "@/lib/db/sql-ops";
import {
  branchFragment,
  searchFragment,
  tagFragment,
  testResultsScopeJoin,
} from "@/lib/analytics/filters";
import type { CatalogGroupMode } from "@/lib/group-catalog-rows";
import {
  normalizeBranchFilter,
  resolveAnalyticsWindow,
} from "@/lib/analytics/params";
import {
  latestPerTestRn,
  latestPerTestValue,
  statusCounter,
} from "@/lib/analytics/per-test";
import { makeRangeParser } from "@/lib/analytics/range";
import { deferredNoStore, pageProjectFields } from "@/lib/page-loader";
import { paginateOffsetTable } from "@/lib/page-window";
import { parsePage } from "@/lib/runs/filters";
import type { TenantScope } from "@/lib/scope";
import { requireTenantContext } from "@/lib/tenant-context";
import {
  parseTestsSort,
  testsCatalogSortSql,
  type TestsSortState,
} from "@/lib/tests-catalog-sort";

export type Props = InferProps<typeof loader>;

const RANGES = ["7d", "14d", "30d"] as const;
type RangeKey = (typeof RANGES)[number];
const parseRange = makeRangeParser<RangeKey>(RANGES, "14d");

const PAGE_SIZE = 50;

export interface TestsPageRow {
  testId: string;
  title: string;
  file: string;
  latestStatus: string;
  lastSeen: number;
  n: number;
  avgDurationMs: number | null;
  passedCount: number;
  flakyCount: number;
  failCount: number;
  skippedCount: number;
}

interface PageQueryRow {
  testId: string;
  lastSeen: number;
  totalDistinct: number;
}

interface AggregateRow {
  testId: string;
  n: number;
  avgDurationMs: number | null;
  title: string | null;
  file: string | null;
  latestStatus: string | null;
  passedCount: number;
  flakyCount: number;
  failCount: number;
  skippedCount: number;
}

/**
 * Test catalog loader. Two-pass query:
 *  1. Paginate testIds by the selected aggregate with a windowed `count(*)
 *     OVER ()` to fold pagination math into the same statement.
 *  2. Aggregate per-test counters + latest title/file/status for the page slice.
 *
 * Plain `defineHandler` with manual `searchParams` parsing (matching the
 * sibling insights/flaky loaders) — REQUIRED for `defer()`: `withValidator`
 * awaits/serializes the handler return, which collapses a `Deferred` prop into
 * a plain resolved object, so the client's `use()` throws "unsupported type".
 * No `void/client#fetch` caller consumes this page loader's query shape, so the
 * typed-routes contract isn't lost in practice.
 */
export const loader = defineHandler(async (c) => {
  const { project, scope } = requireTenantContext(c);

  const url = new URL(c.req.url);
  const range = parseRange(url.searchParams.get("range"));
  const { branchParam, branchFilter } = normalizeBranchFilter(
    url.searchParams.get("branch"),
  );
  const q = (url.searchParams.get("q") ?? "").trim();
  const tags = (url.searchParams.get("tag") ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const tagParam = tags.length > 0 ? tags.join(",") : null;
  const groupRaw = url.searchParams.get("group");
  const group: CatalogGroupMode | null =
    groupRaw === "file" || groupRaw === "suite" ? groupRaw : null;
  const requestedPage = parsePage(url.searchParams.get("page"));
  const sort = parseTestsSort(
    url.searchParams.get("sort"),
    url.searchParams.get("direction"),
  );

  const [branches, availableTags] = await Promise.all([
    loadProjectBranches(scope),
    loadProjectTags(scope),
  ]);
  const { windowStartSec } = resolveAnalyticsWindow(range);

  const branchSql = branchFragment(branchFilter);
  const qSql = searchFragment(q || null, scope.projectId);
  const tagSql = tagFragment(tags);

  deferredNoStore(c);
  return {
    project: pageProjectFields(project),
    range,
    branchParam,
    branchFilter,
    branches,
    q,
    tagParam,
    tags,
    availableTags,
    group,
    sort,
    // The URL page (raw, eager) drives the toolbar hrefs that preserve the
    // current page across a group toggle; the clamped `currentPage` streams
    // with the deferred slice.
    requestedPage,
    pathname: url.pathname,
    ranges: RANGES,

    // The two-pass catalog query — the paginated page slice + windowed total,
    // then the per-test aggregate for that slice — is the page's primary
    // content and its heaviest work, so it streams behind the table skeleton
    // while the toolbar + tag chips paint immediately. The pagination math and
    // the empty-vs-table decision all derive from the page query, so they
    // resolve here too. Returns plain serializable rows.
    catalog: defer(async () => {
      // Offset pagination — the count rides on the slice (the windowed
      // `count(*) OVER ()` in runPageQuery isn't known until the page returns),
      // so `paginateOffsetTable` fetches at the requested offset, derives the
      // total from the rows, and re-fetches the clamped last page on an
      // over-the-end `?page=`. `mapRows` runs the per-test aggregate for the
      // page slice; `toRow` is derived from the mapped length.
      const page = await paginateOffsetTable<PageQueryRow, TestsPageRow>({
        page: requestedPage,
        pageSize: PAGE_SIZE,
        count: { fromSlice: (rows) => rows[0]?.totalDistinct ?? 0 },
        pageQuery: (offset) =>
          runPageQuery(
            scope,
            windowStartSec,
            branchSql,
            qSql,
            tagSql,
            sort,
            offset,
          ),
        mapRows: async (pageRows) => {
          const lastSeenById = new Map(
            pageRows.map((r) => [r.testId, r.lastSeen]),
          );
          const testIds = pageRows.map((r) => r.testId);
          const aggById = await runAggregateQuery(
            scope,
            windowStartSec,
            branchSql,
            tagSql,
            testIds,
          );
          return testIds.flatMap((id) => {
            const a = aggById.get(id);
            const lastSeen = lastSeenById.get(id) ?? 0;
            if (!a) return [];
            return [
              {
                testId: id,
                title: a.title ?? "",
                file: a.file ?? "",
                latestStatus: a.latestStatus ?? "",
                lastSeen,
                n: a.n,
                avgDurationMs: a.avgDurationMs,
                passedCount: a.passedCount,
                flakyCount: a.flakyCount,
                failCount: a.failCount,
                skippedCount: a.skippedCount,
              },
            ];
          });
        },
      });

      return {
        rows: page.rows,
        totalUniqueTests: page.total,
        currentPage: page.currentPage,
        totalPages: page.totalPages,
        fromRow: page.fromRow,
        toRow: page.toRow,
      };
    }),
  };
});

async function runPageQuery(
  scope: TenantScope,
  windowStartSec: number,
  branchSql: ReturnType<typeof sql>,
  qSql: ReturnType<typeof sql>,
  tagSql: ReturnType<typeof sql>,
  sort: TestsSortState,
  offset: number,
): Promise<PageQueryRow[]> {
  // Keep the default last-seen query as lean as it was before sorting: the
  // selected heading's descriptor opts into the one extra aggregate (or catalog
  // join) its ORDER BY needs, and only that. Those values never cross the loader
  // boundary — the second-pass aggregate query recomputes the columns the page
  // actually renders. The descriptor's fragments come from a closed vocabulary
  // (see tests-catalog-sort.ts), so `sql.raw` here is safe.
  const { projection, join, group, orderBy } = testsCatalogSortSql(sort);
  return runRows<PageQueryRow>(sql`
    with grouped as (
      select
        tr."testId" as "testId",
        -- createdAt is int8: a raw runRows read bypasses Drizzle's decoders, so
        -- node-postgres returns max() as a STRING (pglite returns a number,
        -- hiding it). numAggExpr casts it so lastSeen is a JS number on real pg.
        ${numAggExpr(`max(tr."createdAt")`, { alias: `"lastSeen"` })}
        ${sql.raw(projection)}
      from "testResults" tr
      ${sql.raw(join)}
      ${testResultsScopeJoin(scope)}
        and runs."createdAt" >= ${windowStartSec}
        ${branchSql}
        ${qSql}
        ${tagSql}
      group by tr."testId"${sql.raw(group)}
    )
    select
      "testId",
      "lastSeen",
      ${intAggExpr("count(*) over ()", { alias: `"totalDistinct"` })}
    from grouped
    order by ${sql.raw(orderBy)}
    limit ${PAGE_SIZE}
    offset ${offset}
  `);
}

async function runAggregateQuery(
  scope: TenantScope,
  windowStartSec: number,
  branchSql: ReturnType<typeof sql>,
  tagSql: ReturnType<typeof sql>,
  testIds: readonly string[],
): Promise<Map<string, AggregateRow>> {
  const rows = await runRows<AggregateRow>(sql`
    with ranked as (
      select
        tr."testId" as "testId",
        tr.title as title,
        tr.file as file,
        tr.status as status,
        tr."durationMs" as "durationMs",
        tr."createdAt" as "createdAt",
        tr."runId" as "runId",
        tr.id as "testResultId",
        ${latestPerTestRn(`"rnTime"`)}
      from "testResults" tr
      ${testResultsScopeJoin(scope)}
        and runs."createdAt" >= ${windowStartSec}
        and tr."testId" in (${sql.join(
          testIds.map((id) => sql`${id}`),
          sql`, `,
        )})
        ${branchSql}
        -- Same tag predicate as runPageQuery so per-test counts/duration reflect
        -- ONLY the tag-filtered results, not the test's full history. Without it
        -- a tag-filtered page shows correct membership but inflated counts.
        ${tagSql}
    )
    select
      "testId",
      ${intAggExpr("count(*)", { alias: "n" })},
      ${numAggExpr(`avg("durationMs")`, { alias: `"avgDurationMs"` })},
      ${latestPerTestValue("title", { alias: "title" })},
      ${latestPerTestValue("file", { alias: "file" })},
      ${latestPerTestValue("status", { alias: `"latestStatus"` })},
      ${statusCounter("passed", { alias: `"passedCount"` })},
      ${statusCounter("flaky", { alias: `"flakyCount"` })},
      ${statusCounter("fail", { alias: `"failCount"` })},
      ${statusCounter("skipped", { alias: `"skippedCount"` })}
    from ranked
    group by "testId"
  `);
  return new Map(rows.map((r) => [r.testId, r]));
}
