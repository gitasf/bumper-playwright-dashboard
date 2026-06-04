/**
 * The bearer-authenticated reporter ingest surface, as a single predicate.
 *
 * "These ingest routes must each require a Bearer key AND be throttled
 * per-tenant" is one invariant, but it was previously expressed twice — the
 * same two regex literals lived byte-for-byte in both `middleware/02.api-auth.ts`
 * (the Bearer gate) and `middleware/03.rate-limit.ts` (the throttle gate). A
 * maintainer renaming `/api/runs` or adding a new ingest route had to remember
 * to edit both, and nothing failed at build or test time if they drifted:
 *   - authed in 02 but not throttled in 03 → unbounded per-tenant D1 writes.
 *   - throttled in 03 but not authed in 02 → handler calls `getApiKey(c)`, which
 *     throws because 02 never stashed the key → a 500 instead of a clean 401.
 *
 * Both gates now import `isIngestRoute`, so the route set lives in exactly one
 * place and the two cannot drift.
 *
 * The covered routes:
 *   - POST /api/runs                 (open a run)
 *   - POST /api/runs/:id/results     (append a batch)
 *   - POST /api/runs/:id/complete    (finalize)
 *   - POST /api/artifacts/register   (reserve row + return worker upload URL)
 *   - PUT  /api/artifacts/:id/upload (stream into R2 through the worker)
 *
 * Deliberately NOT covered (each has a single consumer in 03 only; folding them
 * in would be a pass-through, not a concentration):
 *   - /api/auth/*                 → AUTH_RATE_LIMITER     (IP-keyed)
 *   - /api/artifacts/:id/download → ARTIFACT_RATE_LIMITER (artifactId-keyed)
 */
const RUN_INGEST_RE = /^\/api\/runs(?:\/|$)/;
const ARTIFACT_INGEST_RE =
  /^\/api\/artifacts\/(?:register|[^/]+\/upload)(?:\/|$)/;

/**
 * `true` when `path` is a Bearer-authenticated reporter ingest route — i.e. a
 * route the auth gate (02) must require a key for AND the throttle gate (03)
 * must key by `apiKey.id`. The single source of truth for that invariant.
 */
export function isIngestRoute(path: string): boolean {
  return RUN_INGEST_RE.test(path) || ARTIFACT_INGEST_RE.test(path);
}
