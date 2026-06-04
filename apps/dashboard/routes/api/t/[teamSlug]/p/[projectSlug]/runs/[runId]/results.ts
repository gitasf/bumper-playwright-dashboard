import { defineHandler } from "void";
import { z } from "zod";
import {
  DEFAULT_RUN_RESULTS_LIMIT,
  loadRunResultsPage,
} from "@/lib/run-results-page";
import { resolveTenantApiScope } from "@/lib/tenant-api-scope";

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
});

/**
 * GET /api/t/:teamSlug/p/:projectSlug/runs/:runId/results
 *
 * Cursor-paginated full set of testResults for a run. Used both as the
 * initial-load source for the run-detail tests list and as the client-side
 * back-paginator for runs that exceed the visible window. The query/paging
 * contract lives in `loadRunResultsPage` (`@/lib/run-results-page`); this
 * handler is auth + query translation only.
 */
export const GET = defineHandler.withValidator({
  query: QuerySchema,
})(async (c, { query }) => {
  const ctx = await resolveTenantApiScope(c);
  if (ctx instanceof Response) return ctx;
  const { scope, runId } = ctx;

  const result = await loadRunResultsPage(scope, runId, {
    cursor: query.cursor ?? null,
    limit: query.limit ?? DEFAULT_RUN_RESULTS_LIMIT,
    status: query.status ?? null,
  });
  if (!result) return c.json({ error: "Not found" }, 404);
  return result;
});
