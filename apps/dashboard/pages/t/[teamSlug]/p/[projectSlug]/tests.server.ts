import { defineHandler, type InferProps } from "void";
import { sql } from "void/db";
import { z } from "zod";
import { loadProjectBranches } from "@/lib/branches-query";
import { loadProjectTags } from "@/lib/tags-query";
import { loadQuarantineByTestId } from "@/lib/quarantine-repo";
import type { QuarantineMode } from "@/lib/quarantine-schemas";
import { runRows } from "@/lib/db-run";
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
  latestRunId: string | null;
  latestTestResultId: string | null;
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
  latestRunId: string | null;
  latestTestResultId: string | null;
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

  const offset = (requestedPage - 1) * PAGE_SIZE;
  let pageRows = await runPageQuery(
    scope,
    windowStartSec,
    branchSql,
    qSql,
    tagSql,
    offset,
  );

  const totalUniqueTests = pageRows[0]?.totalDistinct ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalUniqueTests / PAGE_SIZE));

  let currentPage = requestedPage;
  if (pageRows.length === 0 && totalUniqueTests > 0 && requestedPage > 1) {
    currentPage = totalPages;
    pageRows = await runPageQuery(
      scope,
      windowStartSec,
      branchSql,
      qSql,
      tagSql,
      (currentPage - 1) * PAGE_SIZE,
    );
  } else {
    currentPage = Math.min(requestedPage, totalPages);
  }

  let rows: TestsPageRow[] = [];
  const quarantinedByTestId: Record<
    string,
    { mode: QuarantineMode; reason: string | null }
  > = {};
  if (pageRows.length > 0) {
    const lastSeenById = new Map(pageRows.map((r) => [r.testId, r.lastSeen]));
    const testIds = pageRows.map((r) => r.testId);
    const [aggById, quarantineRows] = await Promise.all([
      runAggregateQuery(scope, windowStartSec, branchSql, tagSql, testIds),
      loadQuarantineByTestId(scope.projectId, testIds),
    ]);
    for (const quarantine of quarantineRows) {
      quarantinedByTestId[quarantine.testId] = {
        mode: quarantine.mode,
        reason: quarantine.reason,
      };
    }
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
          latestRunId: a.latestRunId,
          latestTestResultId: a.latestTestResultId,
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

  const fromRow =
    totalUniqueTests === 0 ? 0 : (currentPage - 1) * PAGE_SIZE + 1;
  const toRow = (currentPage - 1) * PAGE_SIZE + rows.length;

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
      // Owner-only quarantine control; non-owners see only the badge.
      canManageQuarantine: project.role === "owner",
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
    // testId → quarantine state for the per-row badge + control.
    quarantinedByTestId,
    // Set by the quarantine mutation route on a validation / conflict failure
    // (it redirects back here with ?quarantineError=…). Surfaced as a banner.
    quarantineError: url.searchParams.get("quarantineError"),
    totalUniqueTests,
    currentPage,
    totalPages,
    fromRow,
    toRow,
    pathname: url.pathname,
    fullPath: url.pathname + url.search,
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
        count(*) over () as "totalDistinct"
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
      count(*) as n,
      avg("durationMs") as "avgDurationMs",
      ${latestPerTestValue("title", { alias: "title" })},
      ${latestPerTestValue("file", { alias: "file" })},
      ${latestPerTestValue("status", { alias: `"latestStatus"` })},
      ${latestPerTestValue(`"runId"`, { alias: `"latestRunId"` })},
      ${latestPerTestValue(`"testResultId"`, { alias: `"latestTestResultId"` })},
      ${statusCounter("passed", { alias: `"passedCount"` })},
      ${statusCounter("flaky", { alias: `"flakyCount"` })},
      ${statusCounter("fail", { alias: `"failCount"` })},
      ${statusCounter("skipped", { alias: `"skippedCount"` })}
    from ranked
    group by "testId"
  `);
  return new Map(rows.map((r) => [r.testId, r]));
}
