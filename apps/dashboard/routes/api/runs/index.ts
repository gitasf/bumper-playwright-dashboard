import { defineHandler } from "void";
import { getApiKey } from "@/lib/api-auth";
import { tenantScopeForApiKey } from "@/lib/scope";
import { OpenRunPayloadSchema } from "@/lib/schemas";
import {
  backdatingAllowed,
  openRun,
  RunQuotaOvershootError,
  RunRowCapExceededError,
} from "@/lib/ingest";
import { checkQuota } from "@/lib/usage";

function runUrl(scope: { teamSlug: string; projectSlug: string }, id: string) {
  return `/t/${scope.teamSlug}/p/${scope.projectSlug}/runs/${id}`;
}

/**
 * POST /api/runs — open a streaming run. Idempotent on
 * `(projectId, idempotencyKey)` — see `openRun` in `@/lib/ingest`.
 *
 * Auth + version negotiation run in `middleware/02.api-auth.ts`, which sets
 * `c.var.apiKey` before the handler executes.
 */
export const POST = defineHandler.withValidator({
  body: OpenRunPayloadSchema,
})(async (c, { body: payload }) => {
  if (payload.createdAt !== undefined && !backdatingAllowed()) {
    return c.json(
      { error: "createdAt override is only allowed in local development" },
      400,
    );
  }

  const scope = await tenantScopeForApiKey(getApiKey(c));
  const nowSeconds = payload.createdAt ?? Math.floor(Date.now() / 1000);

  // Quota lookup (CI ingest only — the synthetic-monitor path calls openRun
  // directly and is intentionally exempt, so monitoring never silently stops).
  // Do NOT reject a blocked snapshot here: openRun resolves idempotent retries
  // and late shards before its atomic guarded bump. Only a genuinely new insert
  // can throw RunQuotaOvershootError below.
  const quota = await checkQuota(scope.teamId, "runs", 1, nowSeconds);
  const quotaError = () =>
    c.json(
      {
        error:
          "Monthly run quota exceeded for this team. Upgrade the plan or wait for the next billing period.",
        limit: quota.limit,
        used: quota.used,
      },
      429,
    );
  let runId: string;
  let duplicate: boolean;
  let terminalDuplicate: boolean | undefined;
  try {
    ({ runId, duplicate, terminalDuplicate } = await openRun(
      scope,
      payload,
      nowSeconds,
      {
        runsQuotaLimit: quota.limit,
      },
    ));
  } catch (err) {
    if (err instanceof RunQuotaOvershootError) return quotaError();
    // Same 413 contract as /results' rowCapExceeded — the reporter drops the
    // run instead of retrying an open that can never fit.
    if (err instanceof RunRowCapExceededError) {
      return c.json(
        {
          error: `Planned test set exceeds this instance's ${err.limit}-row per-run test-result ceiling.`,
          limit: err.limit,
          count: err.count,
        },
        413,
      );
    }
    throw err;
  }

  if (terminalDuplicate) {
    return c.json(
      {
        error:
          "This idempotency key already belongs to a completed execution. Use a unique key for each CI run attempt.",
        runId,
      },
      409,
    );
  }

  if (quota.status === "softWarn") {
    c.header(
      "X-Wrightful-Quota-Warning",
      `runs ${quota.used + (duplicate ? 0 : 1)}/${quota.limit}`,
    );
  }

  return c.json(
    {
      runId,
      runUrl: runUrl(scope, runId),
      ...(duplicate ? { duplicate: true } : {}),
    },
    duplicate ? 200 : 201,
  );
});
