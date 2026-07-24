import { defineHandler } from "void";
import { z } from "zod";
import { GROUP_BY_AXES, STATUS_FILTER_VALUES } from "@/lib/runs/groups-page";
import {
  DEFAULT_RUN_RESULTS_LIMIT,
  loadRunResultsPage,
} from "@/lib/runs/results-page";
import { resolveTenantApiScope } from "@/lib/tenant-api-scope";
import { attachHasTrace } from "@/lib/trace-presence";

const STATUS_VALUES = [
  "queued",
  "passed",
  "failed",
  "flaky",
  "skipped",
  "timedout",
] as const;

const QuerySchema = z.object({
  status: z.enum(STATUS_VALUES).optional(),
  limit: z.coerce.number().int().positive().optional(),
  cursor: z.string().optional(),
  // The Tests-tab per-group row page: restrict to one group of an axis. A
  // present `groupBy` with an absent `groupKey` selects that axis's fallback
  // group (empty projectName / non-sharded rows); `file`'s fallback is the
  // empty-path string, so an absent key there reads as `""`.
  groupBy: z.enum(GROUP_BY_AXES).optional(),
  groupKey: z.string().optional(),
  // Chip status filter (matches the skeleton: `failed` includes `timedout`,
  // `recommended` = failed ∪ flaky). Distinct from the raw `status` above.
  statusBucket: z.enum(STATUS_FILTER_VALUES).optional(),
  search: z.string().optional(),
});

/**
 * GET /api/t/:teamSlug/p/:projectSlug/runs/:runId/results
 *
 * Cursor-paginated full set of testResults for a run. Used both as the
 * initial-load source for the run-detail tests list and as the client-side
 * back-paginator for runs that exceed the visible window. The query/paging
 * contract lives in `loadRunResultsPage` (`@/lib/runs/results-page`); this
 * handler is auth + query translation, plus the UI-only `hasTrace` enrichment
 * (`attachHasTrace`) that gates the list's per-row "Replay" button — kept out of
 * the shared loader so it never leaks into the public v1 / export / MCP surfaces.
 */
export const GET = defineHandler.withValidator({
  query: QuerySchema,
})(async (c, { query }) => {
  const ctx = await resolveTenantApiScope(c);
  if (ctx instanceof Response) return ctx;
  const { scope, runId } = ctx;

  // A present `groupBy` marks this as a per-group row page. An absent `groupKey`
  // is the axis's fallback group; `groupPredicate` owns the null-vs-empty rule
  // (it coerces a null `file` key to `""`, and maps null project/shard to IS NULL).
  const group = query.groupBy
    ? { axis: query.groupBy, key: query.groupKey ?? null }
    : null;

  const result = await loadRunResultsPage(scope, runId, {
    cursor: query.cursor ?? null,
    limit: query.limit ?? DEFAULT_RUN_RESULTS_LIMIT,
    status: query.status ?? null,
    statusBucket: query.statusBucket ?? null,
    group,
    search: query.search ?? null,
  });
  if (!result) return c.json({ error: "Not found" }, 404);

  return {
    results: await attachHasTrace(scope, result.results),
    nextCursor: result.nextCursor,
  };
});
