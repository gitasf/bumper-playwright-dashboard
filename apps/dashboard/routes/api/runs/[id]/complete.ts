import { defineHandler } from "void";
import { getApiKey } from "@/lib/api-auth";
import { tenantScopeForApiKey } from "@/lib/scope";
import { CompleteRunPayloadSchema } from "@/lib/schemas";
import { backdatingAllowed, completeRun } from "@/lib/ingest";

/**
 * POST /api/runs/:id/complete — finalize a streaming run. See `completeRun`
 * in `@/lib/ingest` for the recompute + broadcast semantics; the handler is
 * auth + translation + the dev-only backdating guard.
 */
export const POST = defineHandler.withValidator({
  body: CompleteRunPayloadSchema,
})(async (c, { body: payload }) => {
  const runId = c.req.param("id");
  if (!runId) return c.json({ error: "Not found" }, 404);

  if (payload.completedAt !== undefined && !backdatingAllowed()) {
    return c.json(
      { error: "completedAt override is only allowed in local development" },
      400,
    );
  }

  const scope = await tenantScopeForApiKey(getApiKey(c));
  const completedAt = payload.completedAt ?? Math.floor(Date.now() / 1000);
  const result = await completeRun(scope, runId, payload, completedAt);

  if (result.kind === "notFound") {
    return c.json({ error: "Run not found" }, 404);
  }
  if (result.kind === "runClosed") {
    // Terminal + idle past the write grace window — refuse the late rewrite
    // (a 4xx so the reporter warns and stops instead of retrying).
    return c.json(
      { error: "Run completed too long ago to accept writes" },
      409,
    );
  }
  if (result.kind === "invalidShard") {
    return c.json(
      {
        error: `Shard metadata must use total ${result.expectedShards} and an index within that range`,
      },
      400,
    );
  }
  return c.json({ runId, status: result.status }, 200);
});
