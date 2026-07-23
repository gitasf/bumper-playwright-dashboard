import { defineHandler } from "void";
import { env } from "void/env";
import { getApiKey } from "@/lib/api-auth";
import { buildRunTestsCsv, csvExportResponse } from "@/lib/export";
import {
  DEFAULT_RUN_RESULTS_LIMIT,
  loadRunResultsPage,
} from "@/lib/runs/results-page";
import { tenantScopeForApiKey } from "@/lib/scope";

/**
 * GET /api/v1/runs/:runId/tests — public, Bearer-authed list of a run's test
 * results. Project-scoped via `tenantScopeForApiKey`; `loadRunResultsPage`
 * validates `(projectId, runId)` ownership and returns null (→ 404) if the run
 * isn't this project's — so a project-A key can't read project-B's tests.
 *
 * JSON: cursor-paged (`?cursor=`, `?limit=`, optional `?status=`) with
 * `nextCursor`. `?format=csv` streams the full set (cursor-paged internally) as
 * a `text/csv` attachment capped at `WRIGHTFUL_EXPORT_MAX_ROWS`.
 */
export const GET = defineHandler(async (c) => {
  const scope = await tenantScopeForApiKey(getApiKey(c));
  const runId = c.req.param("runId");
  if (!runId) return c.json({ error: "Not found" }, 404);

  const url = new URL(c.req.url);

  if (url.searchParams.get("format") === "csv") {
    const maxRows = env.WRIGHTFUL_EXPORT_MAX_ROWS;
    const csv = await buildRunTestsCsv(scope, runId, maxRows);
    if (!csv) return c.json({ error: "Not found" }, 404);
    return csvExportResponse({
      scope,
      csv,
      maxRows,
      filenameSuffix: `run-${runId}-tests`,
      logMessage: "run tests csv export truncated at cap",
      logFields: { runId },
    });
  }

  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw
    ? Number.parseInt(limitRaw, 10)
    : DEFAULT_RUN_RESULTS_LIMIT;
  const statusRaw = url.searchParams.get("status");
  const result = await loadRunResultsPage(scope, runId, {
    cursor: url.searchParams.get("cursor"),
    limit: Number.isFinite(limit) ? limit : DEFAULT_RUN_RESULTS_LIMIT,
    status: statusRaw,
  });
  if (!result) return c.json({ error: "Not found" }, 404);

  return c.json(result);
});
