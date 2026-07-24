# 2026-07-06 — Adopt Cloudflare Workers Cache (edge response caching)

## What changed

Enabled Cloudflare's new [Workers Cache](https://blog.cloudflare.com/workers-cache/)
(`cache: { enabled: true }` in the wrangler config) and added the safety +
policy pieces that make the flag correct for this app. Workers Cache
edge-caches full HTTP responses per their `Cache-Control` headers; a cache hit
is served without invoking the Worker at all — no middleware stack, zero CPU
billed. Purging by tag (`ctx.cache.purge`) exists but is not used yet (nothing
public/purgeable is cached today).

Why this pays off here:

- **Static chunks.** Void deploys with `run_worker_first: ["/**"]`, so every
  `/assets/*.js` fetch currently runs the full Worker + middleware stack (the
  2026-07-05 "Settings page 500" outage was exactly this surface). Chunks
  already carry `public, max-age=31536000, immutable` (Void's asset entry +
  `void.json` `routing.headers`), so with the cache on, repeat chunk fetches
  are edge hits: no Worker invocation, no DB dependency, request-only billing
  instead of request + CPU. The static-asset failure class from that outage
  cannot occur on a cache hit.
- **Worker-proxied artifact bytes.** `buildArtifactHeaders` already emitted
  `public, max-age=31536000, immutable`; on deploys without the direct-R2
  presign keys (ADR 0003 — local dev, e2e, self-hosters) artifact bytes stream
  through the Worker and now edge-cache per token URL. The managed deploy's
  GET path is a `private, no-store` 302 to presigned R2 and is unaffected.

## The safety piece: default-deny middleware

Workers Cache follows RFC 9111 **including heuristic freshness**: a response
with _no_ `Cache-Control` header and a heuristically-cacheable status (200,
404, …) may be stored in the shared cache. Per the docs, only a response
`Set-Cookie` or a request `Authorization` header bypasses automatically — a
session **cookie on the request does not**, and cookies are not part of the
cache key. Several loaders deliberately set no `Cache-Control` (e.g. the
run-detail page, a deferred/streaming loader) — unguarded, flipping the flag
could have served one user's tenant HTML to another.

New `middleware/00.cache.ts` (sorts before `00.errors.ts`, so it is the
outermost middleware and stamps the _final_ response, including the /oops and
/not-found rewrites): after `next()`, if the response has no `Cache-Control`,
set `private, no-store`. Skips WebSocket 101 upgrades; rebuilds the response
if its headers are immutable (fetch pass-throughs). Edge caching is therefore
strictly opt-in via an explicit `public, …` header.

## Details

| Change                           | File                                                           | Notes                                                                                                                                                                                                                                                                                                                    |
| -------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cache: { enabled: true }`       | `apps/dashboard/wrangler.template.jsonc`                       | Flows into generated `wrangler.jsonc` (verified via `gen-wrangler.mjs`); for managed `void deploy` it rides the same pass-through as `ratelimits`/`send_email` — **confirm on the next managed deploy that the platform accepts it**                                                                                     |
| Default-deny stamp               | `apps/dashboard/middleware/00.cache.ts` (new)                  | See above; `00.errors.ts` doc comment updated (it is no longer the outermost middleware)                                                                                                                                                                                                                                 |
| `s-maxage` on artifact responses | `apps/dashboard/src/lib/artifacts.ts` (`buildArtifactHeaders`) | Shared caches capped to the token's **remaining** life (`sharedMaxAgeSeconds`, derived from `exp` in `download.ts`), not the full mint TTL, so an edge-cached response can't outlive the token; browsers keep the year-long `max-age`. 206 partials drop to `private` (not shared-cacheable). See review follow-ups 1–2. |
| wrangler `4.94.0` → `4.101.0`    | `apps/dashboard/package.json`                                  | 4.94's config schema predates the `cache` key — it would not deploy the flag on the own-account `deploy:cf` path; 4.101 (already in the lockfile via void) supports it                                                                                                                                                   |
| Loader comment refresh           | `pages/.../runs/[runId]/index.server.ts`                       | Documents that the no-header streaming loader is now covered by the middleware default                                                                                                                                                                                                                                   |

## Facts pulled from the Cloudflare docs (developers.cloudflare.com/workers/cache/)

- Only GET and HEAD are cached; they share one cache entry per URL.
- Cache key: request path, entrypoint, `ctx.props`, and (by default) Worker
  version — so every deploy naturally invalidates.
- `Set-Cookie` responses and `Authorization` requests bypass automatically;
  request cookies do **not**.
- RFC 9111 semantics including heuristic freshness (the reason the default-deny
  middleware exists).
- At launch all plans cap cacheable responses at 512 MB (artifacts default to
  a 50 MiB cap, so no conflict).
- Billing: hits bill request-only (no CPU). Note: enabling the cache makes
  static-asset requests billable at standard request rate — but under
  `run_worker_first: ["/**"]` ours already invoke the Worker per request, so
  hits get strictly cheaper.

## Verification

- `pnpm check` — 0 errors (120 pre-existing warnings).
- `pnpm --filter @wrightful/dashboard test` — both lanes green (node lane +
  workers lane: 102 files / 1169 tests).
- New `src/__tests__/middleware-cache-default.workers.test.ts` (9 cases):
  stamps missing header (200 + 404), leaves explicit private/public policies
  untouched, skips 101 upgrades, rebuilds immutable-header responses, and
  stamps a Response _thrown_ past `next()` (see review follow-up 3).
- `artifact-response.workers.test.ts` updated for the token-remaining-life
  `s-maxage` and the `private` 206 downgrade (see review follow-ups 1–2).
- `node scripts/gen-wrangler.mjs` — generated `wrangler.jsonc` carries the
  `cache` block (generic fallback mode).

## Review follow-ups (same-day, `/thermo-nuclear-code-quality-review`)

Three correctness gaps found reviewing the change and fixed in this branch;
verified against the live Cloudflare docs that Workers Cache keys on **path +
query string** (so the `?t=` token really is the cache-key capability) and that
request `Cookie` does not bypass (only `Authorization` / response `Set-Cookie`).

1. **`s-maxage` was the full mint TTL, not the token's _remaining_ life**
   (`src/lib/artifacts.ts`). `s-maxage` is measured from cache-store time while
   the token TTL is measured from mint time, so a copy cached from a
   late-in-life token could linger up to ~TTL past the token's expiry — the
   comment's "must not outlive the token" invariant was false. The sibling
   direct-R2 302 path already caps its presigned URL to `exp - now`; the proxy
   path now does the same. `buildArtifactResponse`/`buildArtifactHeaders` take a
   `sharedMaxAgeSeconds` (the caller in `download.ts` derives it from `exp`,
   reused for both the presign `expiresIn` and the proxy `s-maxage`).
2. **206 Range partials were shared-cacheable** (`src/lib/artifacts.ts`).
   Workers Cache keys on the URL and does not vary by `Range`, so a cached 206
   could answer a later full/other-range GET to the same `?t=` URL with the
   wrong bytes. A served range now downgrades to `private, max-age=…, immutable`
   (browser keeps the year-long cache; only full 200s are edge-cacheable). This
   removes the trace-viewer Range risk flagged below.
3. **Thrown Responses on `/api/*` bypassed the default-deny stamp**
   (`middleware/00.cache.ts`). `00.errors` re-throws control-flow Responses on
   API paths, and Hono turns a thrown Response into the wire response — so a GET
   404 with no `Cache-Control` (e.g. `GET /api/github/setup` when the App is
   disabled or the team is missing) could be heuristically edge-cached. The
   middleware now wraps `next()` in a `try/catch`: a thrown Response gets the
   same stamp; genuine Errors (and any explicit policy) propagate unchanged.

Tests: `middleware-cache-default.workers.test.ts` now 9 cases (+ thrown-404
stamp, thrown explicit-policy pass-through, genuine-Error re-throw);
`artifact-response.workers.test.ts` asserts `s-maxage` tracks the option, the
full-200 stays edge-cacheable, and the 206 is `private`. Both lanes green
(node + workers: 102 files / 1169 tests); `pnpm check` 0 errors.

## Left open (deploy-time follow-ups)

- Confirm the managed Void platform accepts/propagates the `cache` key (the
  docs/code pass unknown wrangler keys through, but the platform side can't be
  verified from the repo). If it's dropped, the app still behaves exactly as
  before — the flag is additive.
- After first deploy with the flag: check hit ratios (`BYPASS` vs `HIT`). Full
  (200) artifact bytes are the only edge-cacheable body now; 206 partials are
  browser-private, so trace-viewer Range fetches never hit the shared cache.
- The default stamp is `private, no-store` (not `private` alone). `private`
  already blocks the shared cache; `no-store` is the deliberate stricter choice
  (no authed page in the browser disk cache) and costs bfcache on hard
  back/forward nav — acceptable given SPA navigation. Revisit if bfcache
  restore latency shows up.
