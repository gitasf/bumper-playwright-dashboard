import { defineHandler } from "void";
import { z } from "zod";
import {
  DEFAULT_GROUP_PAGE_SIZE,
  GROUP_BY_AXES,
  loadRunGroupSkeleton,
  STATUS_FILTER_VALUES,
} from "@/lib/run-groups-page";
import { resolveTenantApiScope } from "@/lib/tenant-api-scope";

const QuerySchema = z.object({
  groupBy: z.enum(GROUP_BY_AXES).optional(),
  status: z.enum(STATUS_FILTER_VALUES).optional(),
  search: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().optional(),
});

/**
 * GET /api/t/:teamSlug/p/:projectSlug/runs/:runId/groups
 *
 * A page of the run-detail Tests-tab "group skeleton": worst-first-ordered
 * headers (file / Playwright project / shard) with their 4-bucket counts, for
 * the active status chip + search needle, plus a `nextCursor` to load more
 * groups as the user scrolls the group list. Cheap (one GROUP BY over the run's
 * rows); the per-group ROWS are fetched lazily from `/results` on expand. The
 * query contract lives in `loadRunGroupSkeleton`; this handler is auth +
 * translation.
 */
export const GET = defineHandler.withValidator({
  query: QuerySchema,
})(async (c, { query }) => {
  const ctx = await resolveTenantApiScope(c);
  if (ctx instanceof Response) return ctx;
  const { scope, runId } = ctx;

  const result = await loadRunGroupSkeleton(scope, runId, {
    groupBy: query.groupBy ?? "file",
    status: query.status ?? null,
    search: query.search ?? null,
    cursor: query.cursor ?? null,
    limit: query.limit ?? DEFAULT_GROUP_PAGE_SIZE,
  });
  if (!result) return c.json({ error: "Not found" }, 404);
  return result;
});
