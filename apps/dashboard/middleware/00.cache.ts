import { defineMiddleware } from "void";

/**
 * Default-deny Cache-Control stamp — the safety net for Cloudflare Workers
 * Cache (`cache: { enabled: true }` in wrangler.template.jsonc).
 *
 * Workers Cache follows RFC 9111 *including heuristic freshness*: a response
 * with NO Cache-Control header and a heuristically-cacheable status (200, 404,
 * …) may be stored in the shared edge cache and served to other visitors. A
 * session cookie on the request does NOT bypass the cache (only a response
 * `Set-Cookie` / request `Authorization` header does) and the cache key does
 * not include cookies — so an unstamped, cookie-authed tenant page would be a
 * cross-tenant leak once the shared cache is on. Stamping `private, no-store`
 * on every response that didn't set an explicit policy makes edge caching
 * opt-in: /assets/* chunks (Void's asset entry + void.json routing.headers)
 * and artifact downloads (`src/lib/artifacts/store.ts`) declare `public, …`
 * themselves.
 *
 * Must sort BEFORE `00.errors.ts` (outermost) so the stamp lands on the FINAL
 * response — including the /oops and /not-found rewrites (404 is a
 * heuristically-cacheable status).
 *
 * The stamp covers both ways a response leaves the stack:
 *   - the normal post-`next()` `c.res`, and
 *   - a Response *thrown* past `next()`. On `/api/*` paths `00.errors` never
 *     rewrites; it re-throws control-flow Responses (e.g. a handler's `throw
 *     new Response("Not Found", { status: 404 })`) and genuine Errors alike.
 *     A thrown Response becomes the wire response via Hono's throw-Response
 *     handling, so without the catch below a GET 404 with no Cache-Control
 *     could be heuristically edge-cached. Genuine Errors (and anything that
 *     already set a policy) propagate / pass through unchanged.
 */
export default defineMiddleware(async (c, next) => {
  try {
    await next();
  } catch (err) {
    if (err instanceof Response) {
      // Deliver the thrown Response ourselves so it gets the default stamp;
      // clear `c.res` first so Hono's setter doesn't merge stale headers into
      // the replacement (see 00.errors.ts's replaceResponse).
      const stamped = stampDefault(err);
      c.res = undefined;
      c.res = stamped;
      return;
    }
    throw err;
  }
  const res = c.res;
  if (!res) return;
  const stamped = stampDefault(res);
  // A same-object return means the header was mutated in place (the common
  // case) — no reassignment, so Hono's header-merging setter never runs. Only
  // a rebuilt (immutable-header) response needs the clear-then-set dance.
  if (stamped !== res) {
    c.res = undefined;
    c.res = stamped;
  }
});

/**
 * Apply the default `private, no-store` stamp, returning the response to serve.
 * Returns the SAME object when it stamped in place or had nothing to do (101
 * WebSocket upgrade / an explicit policy already set); returns a fresh rebuilt
 * Response only when the original's headers are immutable (a `fetch()`
 * pass-through). Callers reassign `c.res` only on a rebuild.
 */
function stampDefault(res: Response): Response {
  // WebSocket upgrades (`/ws/*` rooms) carry immutable headers and are never
  // cacheable; leave them untouched.
  if (res.status === 101) return res;
  if (res.headers.has("cache-control")) return res;
  try {
    res.headers.set("cache-control", "private, no-store");
    return res;
  } catch {
    const headers = new Headers(res.headers);
    headers.set("cache-control", "private, no-store");
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  }
}
