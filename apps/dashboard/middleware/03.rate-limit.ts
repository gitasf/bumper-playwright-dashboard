import { defineMiddleware } from "void";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";
import { isIngestRoute } from "@/lib/ingest-routes";

/**
 * Global rate-limit gate. Runs AFTER `02.api-auth.ts` so the ingest paths can
 * key by the resolved `apiKey.id` (tenant-scoped) rather than IP. Three
 * surfaces are throttled, mirroring the bindings declared in `wrangler.jsonc`:
 *
 *   - /api/auth/*                    → AUTH_RATE_LIMITER     keyed by client IP
 *       (no stable identity pre-auth; protects login/signup from credential
 *        stuffing and the password endpoint from brute force).
 *   - /api/runs/*, /api/artifacts/{register,:id/upload}
 *                                    → API_RATE_LIMITER      keyed by apiKey.id
 *       (per-tenant, so CI workers sharing an egress IP don't trip each other;
 *        falls back to client IP if the key somehow isn't stashed).
 *   - /api/artifacts/:id/download    → ARTIFACT_RATE_LIMITER keyed by artifactId
 *       (per-file, since the trace viewer fetches many ranged chunks of one
 *        trace; bounds unbounded byte egress through the Worker).
 *
 * `checkRateLimit` fails open when the binding is missing (local dev), so this
 * is inert under miniflare and active on the deployed worker. A 429 is a plain
 * JSON Response that passes through `00.errors.ts` untouched (it never rewrites
 * /api/* responses).
 *
 * NOTE: this must remain wired. A regression test asserts a 429 past the limit
 * (`src/__tests__/rate-limit.test.ts`) so this can't silently become dead code
 * again — the exact failure mode that shipped in the pre-launch MVP.
 */
const AUTH_RE = /^\/api\/auth(?:\/|$)/;
const ARTIFACT_DOWNLOAD_RE = /^\/api\/artifacts\/([^/]+)\/download(?:\/|$)/;

function tooManyRequests(retryAfterSeconds: number): Response {
  return new Response(JSON.stringify({ error: "Too many requests" }), {
    status: 429,
    headers: {
      "content-type": "application/json",
      "retry-after": String(retryAfterSeconds),
    },
  });
}

export default defineMiddleware(async (c, next) => {
  const path = c.req.path;

  if (AUTH_RE.test(path)) {
    const allowed = await checkRateLimit(
      c.env,
      "AUTH_RATE_LIMITER",
      clientIp(c.req.raw),
    );
    if (!allowed) return tooManyRequests(60);
    await next();
    return;
  }

  const download = ARTIFACT_DOWNLOAD_RE.exec(path);
  if (download) {
    const allowed = await checkRateLimit(
      c.env,
      "ARTIFACT_RATE_LIMITER",
      download[1],
    );
    if (!allowed) return tooManyRequests(60);
    await next();
    return;
  }

  if (isIngestRoute(path)) {
    // 02.api-auth stashes the key before delegating to us; fall back to IP
    // if it's somehow absent so the limiter still functions.
    const apiKey = c.get("apiKey");
    const key = apiKey?.id ?? clientIp(c.req.raw);
    const allowed = await checkRateLimit(c.env, "API_RATE_LIMITER", key);
    if (!allowed) return tooManyRequests(60);
    await next();
    return;
  }

  await next();
});
