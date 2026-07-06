import { all } from "better-all";
import { defineHandler, type InferProps } from "void";
import { and, db, desc, isNotNull, sql } from "void/db";
import { runs } from "@schema";
import {
  DEFAULT_PAGE_SIZE,
  hasAnyFilter,
  parseRunsFilters,
  type RunsFilters,
} from "@/lib/runs-filters";
import { numericSql } from "@/lib/db/sql-ops";
import { resolveOffsetPage } from "@/lib/page-window";
import { scopedRunsWhere } from "@/lib/runs-filters-where";
import { RUN_PUBLIC_COLUMNS } from "@/lib/run-columns";
import { runScopeWhere } from "@/lib/scope";
import { requireTenantContext } from "@/lib/tenant-context";

export type Props = InferProps<typeof loader>;

/**
 * Runs list loader. Fetches a single page of runs plus the dropdown
 * options that feed the filter bar in one round-trip-batch. Returns the
 * filters state straight from the URL so the page component can re-use it
 * for pagination links + the filter-bar form.
 *
 * Active project comes from `middleware/01.context.ts` via
 * `requireTenantContext` — single source of truth, no extra DB join.
 */
export const loader = defineHandler(async (c) => {
  const { project, scope } = requireTenantContext(c);

  const url = new URL(c.req.url);
  const filters = parseRunsFilters(url.searchParams);
  const filtersActive = hasAnyFilter(filters);

  // Count, filter dropdown options, and the page slice in one dependency-aware
  // batch (better-all). The DISTINCT option scans and the count run concurrently;
  // the page slice needs ONLY the count (to clamp the requested page's offset),
  // so it starts as soon as the count lands rather than waiting on the slower
  // DISTINCT scans — one fewer serialized round-trip than a `Promise.all` gated
  // by a separate page query.
  const { totalRuns, branchRows, actorRows, envRows, allRuns } = await all({
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
    async allRuns() {
      // Depends only on the count (to clamp the page offset) — awaits
      // `this.$.totalRuns`, not the DISTINCT scans, so it overlaps them.
      const { offset } = resolveOffsetPage({
        total: await this.$.totalRuns,
        pageSize: DEFAULT_PAGE_SIZE,
        requestedPage: filters.page,
      });
      // Explicit projection (omits idempotencyKey — see RUN_PUBLIC_COLUMNS): a
      // bare .select() serialized the write-reopen credential into props for the
      // whole page of runs.
      return db
        .select(RUN_PUBLIC_COLUMNS)
        .from(runs)
        .where(scopedRunsWhere(scope, filters))
        .orderBy(desc(runs.createdAt))
        .limit(DEFAULT_PAGE_SIZE)
        .offset(offset);
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

  // Page math for the return + pagination links. `resolveOffsetPage` is pure, so
  // recomputing it here (the `allRuns` task derived its own offset from the same
  // inputs) is free and keeps the page values in one place. This loader consumes
  // only the page math (currentPage/totalPages/offset); `fromRow`/`toRow` stay in
  // index.tsx because they fold in the live-row `newCount` from the realtime room.
  const { currentPage, totalPages, offset } = resolveOffsetPage({
    total: totalRuns,
    pageSize: DEFAULT_PAGE_SIZE,
    requestedPage: filters.page,
  });

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
    currentPage,
    totalPages,
    pageSize: DEFAULT_PAGE_SIZE,
    offset,
    filters,
    filtersActive,
    options,
    pathname: url.pathname,
  };
});

// Re-export RunsFilters type for the page component.
export type { RunsFilters };
