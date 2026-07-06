import { defer, defineHandler, type InferProps } from "void";
import { sql } from "void/db";
import { loadProjectBranches } from "@/lib/branches-query";
import { loadProjectTags } from "@/lib/tags-query";
import { runRows } from "@/lib/db-run";
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
import { resolveOffsetPage, shouldRefetchClampedPage } from "@/lib/page-window";
import type { TenantScope } from "@/lib/scope";
import { requireTenantContext } from "@/lib/tenant-context";

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
 *  1. Paginate testIds by `max(testResults.createdAt) DESC` with a windowed
 *     `count(*) OVER ()` to fold pagination math into the same statement.
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
  const pageParam = parseInt(url.searchParams.get("page") ?? "1", 10);
  const requestedPage =
    Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1;

  const [branches, availableTags] = await Promise.all([
    loadProjectBranches(scope),
    loadProjectTags(scope),
  ]);
  const { windowStartSec } = resolveAnalyticsWindow(range);

  const branchSql = branchFragment(branchFilter);
  const qSql = searchFragment(q || null, scope.projectId);
  const tagSql = tagFragment(tags);

  // A deferred loader streams a variant-specific body — set no-store so the
  // browser can't replay the wrong (NDJSON vs HTML) variant.
  c.header("Cache-Control", "private, no-store");
  return {
    project: {
      id: project.id,
      teamId: project.teamId,
      slug: project.slug,
      name: project.name,
      teamSlug: project.teamSlug,
    },
    range,
    branchParam,
    branchFilter,
    branches,
    q,
    tagParam,
    tags,
    availableTags,
    group,
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
      // First fetch runs at the *requested* offset so the windowed
      // `count(*) OVER ()` can report the true total (we don't know it until the
      // page query returns). Then resolve the page math against that total.
      let pageRows = await runPageQuery(
        scope,
        windowStartSec,
        branchSql,
        qSql,
        tagSql,
        (requestedPage - 1) * PAGE_SIZE,
      );

      const totalUniqueTests = pageRows[0]?.totalDistinct ?? 0;
      const { currentPage, totalPages, offset } = resolveOffsetPage({
        total: totalUniqueTests,
        pageSize: PAGE_SIZE,
        requestedPage,
      });

      // Over-the-end `?page=`: the first fetch (at the requested offset) came
      // back empty even though rows exist. Re-fetch at the clamped last-page
      // offset so the table shows the last page rather than an empty slice.
      // This is the one adopter that opts into the refetch dance.
      if (
        shouldRefetchClampedPage({
          total: totalUniqueTests,
          requestedPage,
          currentPage,
          fetchedRowCount: pageRows.length,
        })
      ) {
        pageRows = await runPageQuery(
          scope,
          windowStartSec,
          branchSql,
          qSql,
          tagSql,
          offset,
        );
      }

      let rows: TestsPageRow[] = [];
      if (pageRows.length > 0) {
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
        rows = testIds.flatMap((id) => {
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
      }

      const { fromRow, toRow } = resolveOffsetPage({
        total: totalUniqueTests,
        pageSize: PAGE_SIZE,
        requestedPage,
        rowCount: rows.length,
      });

      return {
        rows,
        totalUniqueTests,
        currentPage,
        totalPages,
        fromRow,
        toRow,
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
  offset: number,
): Promise<PageQueryRow[]> {
  return runRows<PageQueryRow>(sql`
    with grouped as (
      select
        tr."testId" as "testId",
        max(tr."createdAt") as "lastSeen",
        ${intAggExpr("count(*) over ()", { alias: `"totalDistinct"` })}
      from "testResults" tr
      ${testResultsScopeJoin(scope)}
        and runs."createdAt" >= ${windowStartSec}
        ${branchSql}
        ${qSql}
        ${tagSql}
      group by tr."testId"
    )
    select "testId", "lastSeen", "totalDistinct"
    from grouped
    -- "testId" is a unique per-project tiebreaker so OFFSET pagination is stable:
    -- without it, tests sharing a max(createdAt) can be skipped or duplicated
    -- across page boundaries.
    order by "lastSeen" desc, "testId"
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
