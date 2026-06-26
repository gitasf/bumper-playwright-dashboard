import { defineHandler, type InferProps } from "void";
import { sql } from "void/db";
import { z } from "zod";
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
import { resolveOffsetPage, shouldRefetchClampedPage } from "@/lib/page-window";
import type { TenantScope } from "@/lib/scope";
import { requireTenantContext } from "@/lib/tenant-context";

// withValidator's TypedHandler doesn't auto-await the handler return like
// the plain `defineHandler` overload does (see void/dist/handler.d.mts).
// Wrap in `Awaited<>` so consumers see the resolved shape.
export type Props = Awaited<InferProps<typeof loader>>;

const RANGES = ["7d", "14d", "30d"] as const;
type RangeKey = (typeof RANGES)[number];

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
 * Search params are validated via `withValidator({ query })` per Void's
 * typed-routes contract — the schema flows into the auto-generated
 * `.void/routes.d.ts` so client-side `void/client#fetch` callers see the
 * same shape.
 */
export const loader = defineHandler.withValidator({
  query: z.object({
    range: z.enum(RANGES).optional(),
    branch: z.string().optional(),
    q: z.string().optional(),
    /** Comma-separated tag filter (ANY-match). */
    tag: z.string().optional(),
    /** Presentational grouping of the current page. */
    group: z.enum(["file", "suite"]).optional(),
    page: z.coerce.number().int().min(1).optional(),
  }),
})(async (c, { query }) => {
  const { project, scope } = requireTenantContext(c);

  const range: RangeKey = query.range ?? "14d";
  const { branchParam, branchFilter } = normalizeBranchFilter(query.branch);
  const q = (query.q ?? "").trim();
  const tags = (query.tag ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const tagParam = tags.length > 0 ? tags.join(",") : null;
  const group: CatalogGroupMode | null = query.group ?? null;
  const requestedPage = query.page ?? 1;

  const [branches, availableTags] = await Promise.all([
    loadProjectBranches(scope),
    loadProjectTags(scope),
  ]);
  const { windowStartSec } = resolveAnalyticsWindow(range);

  const branchSql = branchFragment(branchFilter);
  const qSql = searchFragment(q || null);
  const tagSql = tagFragment(tags);

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

  // Over-the-end `?page=`: the first fetch (at the requested offset) came back
  // empty even though rows exist. Re-fetch at the clamped last-page offset so
  // the table shows the last page rather than an empty slice. This is the one
  // adopter that opts into the refetch dance.
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
    const lastSeenById = new Map(pageRows.map((r) => [r.testId, r.lastSeen]));
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

  const url = new URL(c.req.url);
  // Staleness-tolerant analytics: cache privately with SWR (see worklog §4).
  // `private` keeps tenant-scoped data out of shared/edge caches.
  c.header("Cache-Control", "private, max-age=300, stale-while-revalidate=900");
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
    rows,
    totalUniqueTests,
    currentPage,
    totalPages,
    fromRow,
    toRow,
    pathname: url.pathname,
    ranges: RANGES,
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
    order by "lastSeen" desc
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
