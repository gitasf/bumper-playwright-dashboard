import { defineHandler } from "void";
import { runs } from "@schema";
import { getApiKey } from "@/lib/api-auth";
import { loadRunColumns, RUN_SUMMARY_COLUMNS } from "@/lib/runs/read-model";
import { tenantScopeForApiKey } from "@/lib/scope";

/**
 * GET /api/v1/runs/:runId — public, Bearer-authed single-run summary.
 *
 * Project-scoped via `tenantScopeForApiKey` + the canonical `loadRunColumns`
 * fetch (`runByIdWhere(scope, runId)` underneath): a run id belonging to
 * another project simply doesn't match → 404 (never leaks existence). The
 * projection is the shared summary base (`RUN_SUMMARY_COLUMNS` — identity,
 * status, VCS/CI context incl. `environment`/`repo`/`origin`, counters,
 * timestamps) plus this surface's one documented extra below.
 */
export const GET = defineHandler(async (c) => {
  const scope = await tenantScopeForApiKey(getApiKey(c));
  const runId = c.req.param("runId");
  if (!runId) return c.json({ error: "Not found" }, 404);

  const run = await loadRunColumns(scope, runId, {
    ...RUN_SUMMARY_COLUMNS,
    // Declared suite size from the reporter's onBegin (summed across shards
    // on a sharded run); null on legacy rows. Lets an API consumer detect a
    // partially-run suite: totalTests < expectedTotalTests ⇒ tests never ran.
    expectedTotalTests: runs.expectedTotalTests,
  });
  if (!run) return c.json({ error: "Not found" }, 404);

  return c.json(run);
});
