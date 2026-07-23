import { defineHandler } from "void";
import { env } from "void/env";
import { getApiKey } from "@/lib/api-auth";
import {
  buildRunsCsv,
  csvExportResponse,
  DEFAULT_RUNS_LIST_LIMIT,
  loadRunsListPage,
} from "@/lib/export";
import { parseRunsFilters } from "@/lib/runs/filters";
import { tenantScopeForApiKey } from "@/lib/scope";

/**
 * GET /api/v1/runs — public, Bearer-authed, project-scoped list of runs.
 *
 * Auth: `middleware/02.api-auth.ts` validates the `Authorization: Bearer <key>`
 * via `isQueryApiRoute` and stashes the key; a missing/invalid key 401s there
 * (NO version handshake — this is not an ingest route). The key binds the caller
 * to exactly one project, recovered here via `tenantScopeForApiKey` — so every
 * query is `(teamId, projectId)`-scoped and a project-A key can never see B.
 *
 * Filtering reuses the dashboard's own `parseRunsFilters` + `scopedRunsWhere`
 * (status / branch / env / actor / date / search / origin). Pagination is
 * opaque cursor (`?cursor=`, `?limit=`); the response carries `nextCursor`.
 *
 * `?format=csv` streams the same cursor walk as a `text/csv` attachment, capped
 * at `WRIGHTFUL_EXPORT_MAX_ROWS` (truncation flagged via header + log).
 */
export const GET = defineHandler(async (c) => {
  const scope = await tenantScopeForApiKey(getApiKey(c));

  const url = new URL(c.req.url);
  const filters = parseRunsFilters(url.searchParams);

  if (url.searchParams.get("format") === "csv") {
    const maxRows = env.WRIGHTFUL_EXPORT_MAX_ROWS;
    const csv = await buildRunsCsv(scope, filters, maxRows);
    return csvExportResponse({
      scope,
      csv,
      maxRows,
      filenameSuffix: "runs",
      logMessage: "runs csv export truncated at cap",
    });
  }

  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw
    ? Number.parseInt(limitRaw, 10)
    : DEFAULT_RUNS_LIST_LIMIT;
  const page = await loadRunsListPage(scope, filters, {
    cursor: url.searchParams.get("cursor"),
    limit: Number.isFinite(limit) ? limit : DEFAULT_RUNS_LIST_LIMIT,
  });

  return c.json(page);
});
