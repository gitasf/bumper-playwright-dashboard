import { defineHandler } from "void";
import { env } from "void/env";
import { buildRunsCsv, csvExportResponse } from "@/lib/export";
import { parseRunsFilters } from "@/lib/runs/filters";
import { resolveProjectApiScope } from "@/lib/tenant-api-scope";

/**
 * GET /api/t/:teamSlug/p/:projectSlug/export/runs[?format=csv&<filters>]
 *
 * In-dashboard ("Export") runs CSV. SESSION-authed (any project member) via
 * `resolveProjectApiScope` — the same `TenantScope` the rest of the dashboard
 * uses, NOT a Bearer key. It then runs the SAME `buildRunsCsv` cursor walk +
 * CSV serializer as the public `routes/api/v1/runs?format=csv`, so the two
 * surfaces produce byte-identical columns from one code path.
 *
 * Honors the same filter-bar params as the runs list (status/branch/env/date/
 * search/origin) so the export matches whatever the user is looking at. Capped
 * at `WRIGHTFUL_EXPORT_MAX_ROWS`; truncation flagged via header + log.
 */
export const GET = defineHandler(async (c) => {
  const ctx = await resolveProjectApiScope(c, "anyMember");
  if (ctx instanceof Response) return ctx;
  const { scope } = ctx;

  const url = new URL(c.req.url);
  const filters = parseRunsFilters(url.searchParams);
  const maxRows = env.WRIGHTFUL_EXPORT_MAX_ROWS;
  const csv = await buildRunsCsv(scope, filters, maxRows);
  return csvExportResponse({
    scope,
    csv,
    maxRows,
    filenameSuffix: "runs",
    logMessage: "dashboard runs csv export truncated at cap",
  });
});
