/**
 * Pure error-gate policy for `middleware/00.errors.ts`.
 *
 * The error middleware has two irreducible entry conditions for the *same*
 * exception — a thrown `Response` propagates out of `next()` (the catch arm),
 * while an `Error`/`HTTPException` is swallowed by Hono into `c.res` before
 * `next()` unwinds (the post-next() arm). Each arm previously re-encoded the
 * identical 401/404/5xx decision table and the identical "log this API
 * failure?" predicate, so a policy change had to be mirrored across two or
 * three look-alike-but-not-interchangeable spots.
 *
 * This module concentrates both policies as pure functions so the two arms
 * differ only in *how they obtain the status* (`extractStatus(err)` vs
 * `c.res?.status`) — not in what they decide. The middleware shell keeps the
 * try/catch + post-next() duality; everything below is side-effect free and
 * unit-tested.
 */

export const OOPS_PATH = "/oops";
export const NOT_FOUND_PATH = "/not-found";
export const LOGIN_PATH = "/login";

const API_PATH_RE = /^\/api\//;
// Last path segment looks like a filename (`foo.ext`). Matches the same
// heuristic void uses internally in `__voidShouldMarkNoMatch`: these URLs
// are served by Vite dev / the static asset layer, not by us. Without the
// guard, every dev source-file fetch (`/pages/.../layout.tsx`, CSS, etc.)
// 404s in the Hono router, hits our post-next() check, and rewrites to
// /not-found.
const FILE_EXT_RE = /\/[^/]+\.[^/]+$/;

export function isApiPath(path: string): boolean {
  return API_PATH_RE.test(path);
}

export function isErrorPage(path: string): boolean {
  return path === OOPS_PATH || path === NOT_FOUND_PATH;
}

export function looksLikeStaticAsset(path: string): boolean {
  return FILE_EXT_RE.test(path);
}

/**
 * Outcome of the HTML error policy. `applyOutcome` in the middleware owns the
 * `c.rewrite`/`replaceResponse` side-effects that realise each kind.
 *
 * - `pass`           — leave the response untouched (not an error we handle).
 * - `redirect-login` — 401 → 302 to /login.
 * - `rewrite-404`    — 404 → render the not-found page, preserving the 404
 *                      status (a missing resource must answer 404, not 200 —
 *                      correct semantics + no existence-leak for foreign
 *                      tenants).
 * - `log-and-oops`   — 5xx / uncaught → log + render /oops, preserving the
 *                      original 5xx status (previously rendered 200, which
 *                      this mapper makes explicit and drift-resistant).
 */
export type ErrorOutcome =
  | { kind: "pass" }
  | { kind: "redirect-login" }
  | { kind: "rewrite-404"; status: 404 }
  | { kind: "log-and-oops"; status: number };

/**
 * Map a derived response status to the HTML error policy. Shared by the catch
 * arm (status from `extractStatus(err)`) and the post-next() HTML arm (status
 * from `c.res?.status`). API paths and the error pages themselves never reach
 * here — the middleware short-circuits them before mapping.
 *
 * Only genuine failures are transformed: 401 → login, 404 → not-found, and
 * uncaught throws (`null`) / 5xx → /oops. EVERYTHING ELSE PASSES THROUGH
 * UNTOUCHED — most importantly successful 2xx pages and 3xx redirects (the
 * logged-out `/` → `/login` redirect is a thrown 302 Response, and a normal
 * page render lands here as a 200 on the post-next() arm), plus intentional
 * 4xx control-flow Responses (403/400/409) a handler may return. Folding any
 * of those into /oops would rewrite normal traffic to the error page.
 */
export function mapErrorOutcome(status: number | null): ErrorOutcome {
  if (status === 401) return { kind: "redirect-login" };
  if (status === 404) return { kind: "rewrite-404", status: 404 };
  if (status === null || status >= 500) {
    return { kind: "log-and-oops", status: status ?? 500 };
  }
  return { kind: "pass" };
}

/**
 * API failures stay machine-readable (reporters + trace viewer keep JSON/text)
 * so they are never rewritten — but genuine failures on the ingest hot path
 * MUST surface in Cloudflare Tail. Log raw throws (`status === null`) and 5xx;
 * intentional 4xx control-flow Responses the handlers throw (404/400/409) stay
 * quiet. Shared by the catch arm (`extractStatus(err)`) and the post-next() API
 * arm (`c.res?.status`).
 */
export function shouldLogApiFailure(status: number | null): boolean {
  return status === null || status >= 500;
}
