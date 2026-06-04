import type { Context } from "hono";
import { requireAuth } from "void/auth";
import { type TenantScope, tenantScopeForUserBySlugs } from "@/lib/scope";

/**
 * The route params every `/api/t/:teamSlug/p/:projectSlug/runs/:runId/*` read
 * handler needs to resolve its tenant scope. `testResultId` is only present on
 * the deeper `tests/:testResultId/*` routes; handlers that don't declare it
 * leave it `null`.
 */
export interface TenantApiParams {
  teamSlug: string;
  projectSlug: string;
  runId: string;
  testResultId: string | null;
}

export interface TenantApiScope {
  scope: TenantScope;
  runId: string;
}

export interface TenantApiTestScope extends TenantApiScope {
  testResultId: string;
}

export interface ResolveTenantApiScopeOpts {
  /** Require (and return) a non-empty `:testResultId` route param. */
  requireTestResultId?: boolean;
}

/**
 * Pure extraction + presence policy for the read-API tenant params. Pulls
 * `teamSlug`, `projectSlug`, `runId` (and, when the route declares it,
 * `testResultId`) from a `name → value` accessor and returns `null` if any
 * required param is missing or empty.
 *
 * Split out from {@link resolveTenantApiScope} so the "which params are
 * required, and a missing one is a *404* (not a 400)" decision is a unit-test
 * surface that doesn't need a Hono `Context` or a live D1. The leak-safe-404
 * mapping of a `null` here lives in the impure wrapper.
 */
export function readTenantApiParams(
  getParam: (name: string) => string | undefined,
  opts: ResolveTenantApiScopeOpts = {},
): TenantApiParams | null {
  const teamSlug = getParam("teamSlug");
  const projectSlug = getParam("projectSlug");
  const runId = getParam("runId");
  if (!teamSlug || !projectSlug || !runId) return null;

  let testResultId: string | null = null;
  if (opts.requireTestResultId) {
    const raw = getParam("testResultId");
    if (!raw) return null;
    testResultId = raw;
  }

  return { teamSlug, projectSlug, runId, testResultId };
}

/**
 * Session-API sibling of `requireTenantContext` (`@/lib/tenant-context`).
 *
 * The read handlers under `routes/api/t/:teamSlug/p/:projectSlug/runs/:runId/*`
 * can't reuse `requireTenantContext`: `middleware/01.context.ts` short-circuits
 * every `/api/*` path with a stub bundle and never populates `activeProject`,
 * so there's no resolved active project to read. They are forced onto the
 * manual `tenantScopeForUserBySlugs` path — which, until this seam, meant each
 * handler re-implemented the same auth → param → scope → leak-safe-404 ritual
 * verbatim (~10 lines × 4 files).
 *
 * Call it at the top of a handler body and short-circuit on a `Response`:
 *
 * ```ts
 * const ctx = await resolveTenantApiScope(c);
 * if (ctx instanceof Response) return ctx;
 * // ctx.scope / ctx.runId are ready
 * ```
 *
 * It is a body-level call (not a `defineHandler` replacement) so it composes
 * with both `defineHandler(...)` and `defineHandler.withValidator({...})(...)`.
 *
 * The leak-safe-404 contract — a missing route param and a no-membership miss
 * BOTH answer `404 { error: "Not found" }` (never 403, to avoid leaking
 * team/project existence to non-members) — now lives in exactly this one
 * place, instead of as a convention every new handler has to remember.
 */
export async function resolveTenantApiScope(
  c: Context,
  opts: ResolveTenantApiScopeOpts & { requireTestResultId: true },
): Promise<TenantApiTestScope | Response>;
export async function resolveTenantApiScope(
  c: Context,
  opts?: ResolveTenantApiScopeOpts,
): Promise<TenantApiScope | Response>;
export async function resolveTenantApiScope(
  c: Context,
  opts: ResolveTenantApiScopeOpts = {},
): Promise<TenantApiScope | TenantApiTestScope | Response> {
  const user = requireAuth(c);
  const params = readTenantApiParams((name) => c.req.param(name), opts);
  if (!params) return c.json({ error: "Not found" }, 404);

  const scope = await tenantScopeForUserBySlugs(
    user.id,
    params.teamSlug,
    params.projectSlug,
  );
  if (!scope) return c.json({ error: "Not found" }, 404);

  if (params.testResultId !== null) {
    return { scope, runId: params.runId, testResultId: params.testResultId };
  }
  return { scope, runId: params.runId };
}
