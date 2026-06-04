import { defineMiddleware } from "void";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { logger } from "void/log";
import {
  type ErrorOutcome,
  isApiPath,
  isErrorPage,
  LOGIN_PATH,
  looksLikeStaticAsset,
  mapErrorOutcome,
  NOT_FOUND_PATH,
  OOPS_PATH,
  shouldLogApiFailure,
} from "../src/lib/error-outcome";

/**
 * Global error gate. Surfaces unhandled exceptions, thrown Responses, and
 * downstream 4xx/5xx as styled HTML pages instead of plain "Internal Server
 * Error" / "Not Found" / "Unauthorized" text.
 *
 * Hono's `compose` catches anything `instanceof Error` (including
 * `HTTPException`, which `void/auth`'s `requireAuth` throws) and converts
 * it to a `Response` via the framework's default error handler before
 * unwinding `next()`. A plain `throw new Response(...)` is NOT an Error,
 * so it propagates back out of `next()` like a normal exception. To cover
 * both, this middleware combines:
 *   1. a try/catch around `next()` for thrown Responses, and
 *   2. an after-the-fact inspection of `c.res.status` for HTTPException-
 *      derived responses Hono already swallowed.
 *
 * The two arms are an irreducible duality (same exception, two unwinding
 * paths) and so the *shell* stays here; the 401/404/5xx decision table and
 * the API-failure logging predicate are concentrated in
 * `src/lib/error-outcome.ts` so the arms differ only in how they derive the
 * status (`extractStatus(err)` vs `c.res?.status`), not in what they decide.
 *
 * Behavior:
 *   - `/api/*`              → never rewrites; reporters + trace viewer keep
 *                             machine-readable JSON/text.
 *   - HTML requests:
 *       - 401               → redirect to /login.
 *       - 404               → rewrite to the catch-all 404 page (preserving 404).
 *       - 5xx / uncaught    → log + rewrite to /oops (preserving the 5xx status).
 *   - Already on /oops or /not-found → pass through to avoid loops.
 *
 * Must be the first middleware (`00.`) so the try/catch and the
 * post-next() inspection both bracket `01.context.ts`, `02.api-auth.ts`,
 * and every downstream loader.
 */
export default defineMiddleware(async (c, next) => {
  const path = c.req.path;
  const isApi = isApiPath(path);
  const alreadyErrorPage = isErrorPage(path);

  try {
    await next();
  } catch (err) {
    if (isApi) {
      // /api/* responses stay machine-readable (reporters + trace viewer), so
      // we never rewrite them to HTML — but unexpected failures on the ingest
      // hot path MUST surface in Cloudflare Tail. Log genuine errors (raw
      // throws and 5xx) before re-throwing; intentional 4xx control-flow
      // Responses (404/400/409 the handlers throw) stay quiet.
      const apiStatus = extractStatus(err);
      if (shouldLogApiFailure(apiStatus)) {
        logger.error("unhandled error on api request", {
          path,
          status: apiStatus ?? 500,
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
      }
      throw err;
    }
    if (alreadyErrorPage) throw err;

    const outcome = mapErrorOutcome(extractStatus(err));
    // A thrown Response we don't transform — a 3xx redirect (the logged-out
    // `/` → /login redirect is a thrown 302) or an intentional 4xx — must be
    // delivered as-is. It was thrown, never assigned to `c.res`, so the `pass`
    // branch of applyOutcome (which returns `c.res`) can't recover it here.
    if (outcome.kind === "pass") {
      if (err instanceof Response) return err;
      throw err;
    }
    return await applyOutcome(c, outcome, path, err);
  }

  if (isApi) {
    // Hono converts a thrown Error (e.g. a failed `db.batch` in the ingest
    // pipeline) into a 500 Response BEFORE `next()` unwinds, so the catch
    // above never sees it — the throw doesn't propagate. Catch that case here:
    // log API 5xx (with the stashed `c.error`) so ingest failures surface in
    // Cloudflare Tail. We still never rewrite /api/* responses — reporters and
    // the trace viewer keep the machine-readable body.
    const apiStatus = c.res?.status ?? null;
    if (shouldLogApiFailure(apiStatus) && apiStatus !== null) {
      logger.error("api 5xx response", {
        path,
        status: apiStatus,
        message: c.error instanceof Error ? c.error.message : undefined,
        stack: c.error instanceof Error ? c.error.stack : undefined,
      });
    }
    return;
  }
  if (alreadyErrorPage || looksLikeStaticAsset(path)) return;

  // HTTPException paths land here: `await next()` returned normally, but
  // Hono's default errorHandler turned the exception into a Response and
  // stashed it on `c.res` / `c.error`.
  const responseStatus = c.res?.status ?? null;
  if (responseStatus === null) return;
  await applyOutcome(c, mapErrorOutcome(responseStatus), path, c.error);
});

/**
 * Realise an {@link ErrorOutcome} on the Hono context. Owns the
 * `c.rewrite`/`replaceResponse` side-effects and the 404/5xx status
 * preservation so both the catch arm and the post-next() HTML arm route
 * through one mechanism.
 *
 * We cannot lean on `c.redirect()` / a bare `c.rewrite()` in the post-next()
 * arm: the swallowed-error `c.res` carries content-length / content-type, and
 * Hono's `c.res` setter merges old headers into whatever we assign next, which
 * corrupts our replacement. Clearing `c.res` first (`= undefined` bypasses the
 * merge branch) then assigning the fresh response is the fix — and applying it
 * uniformly in both arms keeps the two entry points behaviorally identical.
 */
async function applyOutcome(
  c: Context,
  outcome: ErrorOutcome,
  path: string,
  err: unknown,
): Promise<Response> {
  switch (outcome.kind) {
    case "redirect-login": {
      const response = new Response(null, {
        status: 302,
        headers: { Location: LOGIN_PATH },
      });
      replaceResponse(c, response);
      return response;
    }
    case "rewrite-404": {
      const rewritten = await c.rewrite(NOT_FOUND_PATH);
      // Preserve the 404 status (the rewrite target renders 200) so a missing
      // resource answers 404, not 200 — correct semantics + no existence-leak
      // signal for foreign tenants.
      const response = new Response(rewritten.body, {
        status: 404,
        headers: rewritten.headers,
      });
      replaceResponse(c, response);
      return response;
    }
    case "log-and-oops": {
      logger.error("unhandled error in request pipeline", {
        path,
        status: outcome.status,
        message: err instanceof Error ? err.message : undefined,
      });
      const rewritten = await c.rewrite(OOPS_PATH);
      // Preserve the original 5xx status (the rewrite target renders 200).
      const response = new Response(rewritten.body, {
        status: outcome.status,
        headers: rewritten.headers,
      });
      replaceResponse(c, response);
      return response;
    }
    case "pass":
      return c.res;
  }
}

function extractStatus(err: unknown): number | null {
  if (err instanceof Response) return err.status;
  if (err instanceof HTTPException) return err.status;
  return null;
}

function replaceResponse(c: Context, response: Response): void {
  c.res = undefined;
  c.res = response;
}
