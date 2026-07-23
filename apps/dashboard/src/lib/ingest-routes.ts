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

/**
 * The Bearer-authenticated PUBLIC QUERY / EXPORT surface (`/api/v1/*`), as a
 * single predicate — the read-path sibling of {@link isIngestRoute} (roadmap
 * 2.5). Same source-of-truth rationale: both the auth gate (02) and the
 * throttle gate (03) import it so the two can't drift.
 *
 * It is DELIBERATELY a separate auth branch from ingest, not a folding-in:
 *
 *   - 02.api-auth does Bearer lookup + `getApiKey` stash here, but NOT
 *     `negotiateVersionOrResponse`. The query API is a stable read contract for
 *     CLIs/scripts/spreadsheets and carries no `X-Wrightful-Version` handshake,
 *     so a missing/invalid key answers a clean 401 — there is NO 409 version
 *     path on this surface (which is what proves the branch is distinct from
 *     ingest's version-gated path).
 *   - 03.rate-limit throttles `/api/v1/*` under the looser `QUERY_RATE_LIMITER`
 *     (a read pull, possibly large CSV pages, is not the high-frequency
 *     small-write shape `API_RATE_LIMITER` is budgeted for), still keyed by
 *     `apiKey.id` with an IP fallback.
 *
 * `/api/v1/*` is a fresh, versioned namespace with no overlap with the ingest
 * routes (`/api/runs/*`, `/api/artifacts/*`) or the session-authed `/api/t/*`,
 * so the two predicates are disjoint over every `/api/*` path — asserted in
 * `src/__tests__/ingest-routes.test.ts`.
 *
 * `/api/mcp` (the MCP server endpoint, `routes/api/mcp/index.ts`) is part of
 * this SAME surface, not a third one: an MCP client sends
 * `Authorization: Bearer <key>` exactly like a query CLI, there is no
 * `X-Wrightful-Version` handshake (MCP negotiates its own protocol version
 * inside the JSON-RPC layer), and its read tools are the same project-scoped
 * queries the `/api/v1/*` routes serve — so it wants the same auth branch and
 * the same per-key `QUERY_RATE_LIMITER` budget.
 */
const QUERY_API_RE = /^\/api\/(?:v1|mcp)(?:\/|$)/;

export function isQueryApiRoute(path: string): boolean {
  return QUERY_API_RE.test(path);
}

/**
 * The MCP endpoint alone, as a sub-predicate of {@link isQueryApiRoute}
 * (every MCP path IS a query path — asserted in `ingest-routes.test.ts`).
 * 02.api-auth branches on it because /api/mcp accepts TWO Bearer credentials
 * — a project API key OR a Better Auth MCP OAuth access token — and its 401s
 * must carry the `WWW-Authenticate: Bearer resource_metadata=…` challenge
 * that triggers an MCP client's OAuth flow. The plain `/api/v1/*` query
 * routes stay key-only with a bare 401.
 */
const MCP_RE = /^\/api\/mcp(?:\/|$)/;

export function isMcpRoute(path: string): boolean {
  return MCP_RE.test(path);
}

/** Session-authenticated tenant API routes, throttled by client IP. */
const TENANT_API_RE = /^\/api\/t\/[^/]+\/p\/[^/]+(?:\/|$)/;

export function isTenantApiRoute(path: string): boolean {
  return TENANT_API_RE.test(path);
}
