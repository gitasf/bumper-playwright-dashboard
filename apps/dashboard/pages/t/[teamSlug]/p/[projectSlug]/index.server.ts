import { all } from "better-all";
import { defineHandler, type InferProps } from "void";
import { and, db, desc, isNotNull, sql } from "void/db";
import { runs } from "@schema";
import {
  DEFAULT_PAGE_SIZE,
  hasAnyFilter,
  parseRunsFilters,
  type RunsFilters,
} from "@/lib/runs/filters";
import { numericSql } from "@/lib/db/sql-ops";
import { buildRunsPageWhere } from "@/lib/export";
import { decodeCursor, encodeCursor } from "@/lib/runs/results-page";
import { scopedRunsWhere } from "@/lib/runs/filters-where";
import { RUN_PUBLIC_COLUMNS } from "@/lib/runs/columns";
import { runScopeWhere } from "@/lib/scope";
import { requireTenantContext } from "@/lib/tenant-context";

export type Props = InferProps<typeof loader>;

/**
 * Split the comma-joined ancestor-cursor stack (`?history=`) into raw opaque
 * cursors. Entries are base64 (no comma in the alphabet), so a plain split is
 * safe. Never decoded here — only re-emitted verbatim into a "Previous"
 * `?cursor=` — so a corrupt entry yields a broken link, never a bad query.
 */
function parseHistoryStack(raw: string | null): string[] {
  if (!raw) return [];
  return raw.split(",").filter((s) => s.length > 0);
}

/**
 * Runs list loader. Fetches a page of runs (keyset/cursor pagination) plus
 * the dropdown options that feed the filter bar in one round-trip-batch.
 * Returns the filters state straight from the URL so the page component can
 * re-use it for the filter-bar form and for building the prev/next hrefs.
 *
 * Pagination is opaque-cursor (`?cursor=`), reusing the export/public-query
 * surface's `(createdAt, id)` DESC keyset walk + wire codec
 * (`buildRunsPageWhere` in `@/lib/export`, `decode`/`encodeCursor` in
 * `@/lib/runs/results-page`) rather than forking, but with the dashboard's own
 * `RUN_PUBLIC_COLUMNS` projection (the export column set omits `teamId`/
 * `ciBuildId` this page needs). A malformed/absent cursor degrades to the
 * first page (codec contract). "Previous" is an ancestor-cursor stack in
 * `?history=` (comma-joined, oldest first) — keyset can't jump to an arbitrary
 * page number, so there's no numbered page strip here.
 *
 * Active project comes from `middleware/01.context.ts` via
 * `requireTenantContext` — single source of truth, no extra DB join.
 */
export const loader = defineHandler(async (c) => {
  const { project, scope } = requireTenantContext(c);

  const url = new URL(c.req.url);
  const filters = parseRunsFilters(url.searchParams);
  const filtersActive = hasAnyFilter(filters);

  const rawCursor = url.searchParams.get("cursor");
  const cursor = decodeCursor(rawCursor);
  // A bad/absent cursor degrades to page one; an invalid cursor also discards
  // any `?history=` riding along (no trustworthy stack for a page we couldn't
  // resolve).
  const historyStack = cursor
    ? parseHistoryStack(url.searchParams.get("history"))
    : [];
  // 0-based position of this page, for "Showing X–Y of N" — holds as long as
  // every prior page was reached via our own next/prev links (every page but
  // the last is a full `DEFAULT_PAGE_SIZE` slice).
  const pageIndex = cursor ? historyStack.length + 1 : 0;

  // Count, filter options, and the page slice run concurrently (better-all).
  // The slice no longer needs the count (keyset doesn't clamp an offset), so
  // it's independent of the other three, unlike the offset-paginated version.
  const { totalRuns, branchRows, actorRows, envRows, allRuns, nextCursor } =
    await all({
      async totalRuns(): Promise<number> {
        const rows = await db
          .select({ value: numericSql(sql`count(*)`) })
          .from(runs)
          .where(scopedRunsWhere(scope, filters));
        return rows[0]?.value ?? 0;
      },
      async branchRows() {
        return db
          .selectDistinct({ value: runs.branch })
          .from(runs)
          .where(and(runScopeWhere(scope), isNotNull(runs.branch)));
      },
      async actorRows() {
        return db
          .selectDistinct({ value: runs.actor })
          .from(runs)
          .where(and(runScopeWhere(scope), isNotNull(runs.actor)));
      },
      async envRows() {
        return db
          .selectDistinct({ value: runs.environment })
          .from(runs)
          .where(and(runScopeWhere(scope), isNotNull(runs.environment)));
      },
      // Fetch one row beyond the page size to detect `hasMore` without a
      // separate count query — `nextCursor` below slices it back off.
      async pageRows() {
        // Explicit projection (omits idempotencyKey — see RUN_PUBLIC_COLUMNS): a
        // bare .select() serialized the write-reopen credential into props for
        // the whole page of runs.
        return db
          .select(RUN_PUBLIC_COLUMNS)
          .from(runs)
          .where(buildRunsPageWhere(scope, filters, cursor))
          .orderBy(desc(runs.createdAt), desc(runs.id))
          .limit(DEFAULT_PAGE_SIZE + 1);
      },
      async allRuns() {
        const rows = await this.$.pageRows;
        return rows.length > DEFAULT_PAGE_SIZE
          ? rows.slice(0, DEFAULT_PAGE_SIZE)
          : rows;
      },
      async nextCursor() {
        const rows = await this.$.pageRows;
        if (rows.length <= DEFAULT_PAGE_SIZE) return null;
        const last = rows[DEFAULT_PAGE_SIZE - 1];
        return last ? encodeCursor(last.createdAt, last.id) : null;
      },
    });

  const options = {
    branches: branchRows
      .map((r) => r.value)
      .filter((v): v is string => !!v)
      .sort(),
    actors: actorRows
      .map((r) => r.value)
      .filter((v): v is string => !!v)
      .sort(),
    environments: envRows
      .map((r) => r.value)
      .filter((v): v is string => !!v)
      .sort(),
  };

  return {
    project: {
      id: project.id,
      teamId: project.teamId,
      slug: project.slug,
      name: project.name,
      teamSlug: project.teamSlug,
      teamName: project.teamName,
      role: project.role,
    },
    runs: allRuns,
    totalRuns,
    // Opaque cursor that resolved this page — `null` on the first page (absent
    // or malformed `?cursor=`). index.tsx pushes it onto the `?history=` stack
    // for the "Next" href and pops the stack tail for "Previous".
    currentCursor: cursor ? rawCursor : null,
    historyStack,
    nextCursor,
    pageSize: DEFAULT_PAGE_SIZE,
    // 1-based first-row index for the "Showing X–Y of N" footer — derived from
    // `pageIndex` above, not re-fetched.
    offset: pageIndex * DEFAULT_PAGE_SIZE,
    filters,
    filtersActive,
    options,
    pathname: url.pathname,
  };
});

// Re-export RunsFilters type for the page component.
export type { RunsFilters };
