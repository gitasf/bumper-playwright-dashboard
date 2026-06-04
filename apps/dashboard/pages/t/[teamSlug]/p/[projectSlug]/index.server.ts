import { defineHandler, type InferProps } from "void";
import { and, db, desc, isNotNull, sql } from "void/db";
import { runs } from "@schema";
import {
  DEFAULT_PAGE_SIZE,
  hasAnyFilter,
  parseRunsFilters,
  type RunsFilters,
} from "@/lib/runs-filters";
import { scopedRunsWhere } from "@/lib/runs-filters-where";
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

  // Total rows + filter dropdown options + first page in parallel.
  const totalRunsPromise: Promise<number> = db
    .select({ value: sql<number>`count(*)` })
    .from(runs)
    .where(scopedRunsWhere(scope, filters))
    .then((rows) => rows[0]?.value ?? 0);

  const [branchRows, actorRows, envRows, totalRuns] = await Promise.all([
    db
      .selectDistinct({ value: runs.branch })
      .from(runs)
      .where(and(runScopeWhere(scope), isNotNull(runs.branch))),
    db
      .selectDistinct({ value: runs.actor })
      .from(runs)
      .where(and(runScopeWhere(scope), isNotNull(runs.actor))),
    db
      .selectDistinct({ value: runs.environment })
      .from(runs)
      .where(and(runScopeWhere(scope), isNotNull(runs.environment))),
    totalRunsPromise,
  ]);

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

  const totalPages = Math.max(1, Math.ceil(totalRuns / DEFAULT_PAGE_SIZE));
  const currentPage = Math.min(filters.page, totalPages);
  const offset = (currentPage - 1) * DEFAULT_PAGE_SIZE;

  const allRuns = await db
    .select()
    .from(runs)
    .where(scopedRunsWhere(scope, filters))
    .orderBy(desc(runs.createdAt))
    .limit(DEFAULT_PAGE_SIZE)
    .offset(offset);

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
