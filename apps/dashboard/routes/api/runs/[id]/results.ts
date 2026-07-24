import { defineHandler } from "void";
import { getApiKey } from "@/lib/api-auth";
import { tenantScopeForApiKey } from "@/lib/scope";
import { AppendResultsPayloadSchema } from "@/lib/schemas";
import { appendRunResults } from "@/lib/ingest";

/**
 * POST /api/runs/:id/results — append a batch of test results. See
 * `appendRunResults` in `@/lib/ingest` for the batch semantics; the handler
 * is auth + translation only.
 */
export const POST = defineHandler.withValidator({
  body: AppendResultsPayloadSchema,
})(async (c, { body: payload }) => {
  const runId = c.req.param("id");
  if (!runId) return c.json({ error: "Not found" }, 404);

  const scope = await tenantScopeForApiKey(getApiKey(c));
  const nowSeconds = Math.floor(Date.now() / 1000);
  const result = await appendRunResults(scope, runId, payload, nowSeconds);

  if (result.kind === "notFound") {
    return c.json({ error: "Run not found" }, 404);
  }
  if (result.kind === "runClosed") {
    // Terminal status + past the straggler grace window — refuse the rewrite
    // (a 4xx so the reporter drops the batch instead of retrying).
    return c.json(
      { error: "Run completed too long ago to accept results" },
      409,
    );
  }
  if (result.kind === "rowCapExceeded") {
    return c.json(
      {
        error: `Run has reached its ${result.limit}-row test-result ceiling; no more results can be appended to this run.`,
        limit: result.limit,
        count: result.count,
      },
      413,
    );
  }
  return c.json({ results: result.mapping }, 200);
});
