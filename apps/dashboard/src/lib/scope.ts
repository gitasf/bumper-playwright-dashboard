import { and, db, eq, lt, sql } from "void/db";
import { projects, runs, teams } from "@schema";
import type { ApiKey } from "@schema";

/**
 * Branded id types make it a compile-time error to feed a raw string
 * `projectId` into a scoped query without going through `tenantScope*` or
 * `requireTenantContext`. Preserves the same invariant the per-DO
 * `TenantScope` enforced before: every run-table query MUST carry an
 * auth-checked project id.
 */
export type AuthorizedTeamId = string & { readonly __team: unique symbol };
export type AuthorizedProjectId = string & {
  readonly __project: unique symbol;
};

export interface TenantScope {
  readonly teamId: AuthorizedTeamId;
  readonly projectId: AuthorizedProjectId;
  readonly teamSlug: string;
  readonly projectSlug: string;
}

/**
 * The single point where raw `teamId` / `projectId` strings cross the brand
 * boundary into a `TenantScope`. Every scope producer — `tenantScopeForUserBySlugs`,
 * `tenantScopeForApiKey`, and `toScope` in `@/lib/tenant-context` — funnels
 * through here, so the two security-load-bearing `as Authorized*Id` casts live
 * in exactly one place instead of being re-applied at each call site.
 *
 * The two casts are the ONLY sanctioned launder from `string` to a branded id.
 * Callers must only pass ids they have already auth-checked (a membership join,
 * an API-key binding, or an already-resolved active project from middleware).
 */
export function makeTenantScope(parts: {
  teamId: string;
  projectId: string;
  teamSlug: string;
  projectSlug: string;
}): TenantScope {
  return {
    /* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- the sole sanctioned string→branded-id launder; callers pass only auth-checked ids (see fn doc) */
    teamId: parts.teamId as AuthorizedTeamId,
    projectId: parts.projectId as AuthorizedProjectId,
    /* oxlint-enable typescript-eslint/no-unsafe-type-assertion */
    teamSlug: parts.teamSlug,
    projectSlug: parts.projectSlug,
  };
}

/**
 * Resolve the tenant scope for a session-authenticated request that *isn't*
 * gated by `middleware/01.context.ts` (i.e. an API route under
 * `/api/t/...` where the middleware regex doesn't fire). Looks up the
 * project + verifies membership in one query.
 *
 * For `/t/:teamSlug/p/:projectSlug/*` page loaders, use
 * `requireTenantContext(c)` from `@/lib/tenant-context` — it reads the
 * already-resolved active project from middleware context and skips the
 * extra DB round trip.
 *
 * Returns null when the team doesn't exist, the project doesn't exist, or
 * the user isn't a member. Callers should map null to 404 — don't leak
 * existence.
 */
export async function tenantScopeForUserBySlugs(
  userId: string,
  teamSlug: string,
  projectSlug: string,
): Promise<TenantScope | null> {
  const { resolveProjectBySlugs } = await import("@/lib/authz");
  const project = await resolveProjectBySlugs(userId, teamSlug, projectSlug);
  if (!project) return null;
  return makeTenantScope({
    teamId: project.teamId,
    projectId: project.id,
    teamSlug: project.teamSlug,
    projectSlug: project.slug,
  });
}

/**
 * Resolve the tenant scope for an API-key authenticated ingest request. The
 * key already binds the caller to exactly one project; one indexed join on
 * `projects` recovers the parent team plus the slugs the reporter needs for
 * its public-facing run URL. Throws 404 if the key's project was removed.
 */
export async function tenantScopeForApiKey(
  apiKey: Pick<ApiKey, "projectId">,
): Promise<TenantScope> {
  const rows = await db
    .select({
      teamId: projects.teamId,
      teamSlug: teams.slug,
      projectSlug: projects.slug,
    })
    .from(projects)
    .innerJoin(teams, eq(teams.id, projects.teamId))
    .where(eq(projects.id, apiKey.projectId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new Response("Project not found", { status: 404 });
  }
  return makeTenantScope({
    teamId: row.teamId,
    projectId: apiKey.projectId,
    teamSlug: row.teamSlug,
    projectSlug: row.projectSlug,
  });
}

/** A non-undefined Drizzle WHERE fragment, suitable for `.where(...)`. */
type SqlFragment = NonNullable<ReturnType<typeof and>>;

/**
 * The blessed tenant predicate for the `runs` table.
 *
 * `runs` is the only run-scoped table carrying BOTH `teamId` and `projectId`
 * (the denormalized copy that gives the brand its defense-in-depth — see the
 * schema comment on `runs.teamId`). Every reader/writer of the `runs` table
 * that scopes by tenant — the runs-list count/page, branch/actor/environment
 * option lookups, the run-history history query, insights aggregates — ANDs
 * exactly this pair. Concentrating it here means the `(teamId, projectId)`
 * shape (and the fact that it's *both* columns, not just one) lives in one
 * place instead of being copy-pasted at ~10 call sites.
 *
 * Brand load-bearing: the parameter is a `TenantScope`, so the predicate can
 * only be built from auth-checked ids — a raw `string` projectId won't type.
 */
export function runScopeWhere(scope: TenantScope): SqlFragment {
  return and(
    eq(runs.teamId, scope.teamId),
    eq(runs.projectId, scope.projectId),
  )!;
}

/**
 * The blessed predicate for looking a single `runs` row up by id within a
 * tenant: `(projectId, runId)`. This is the single most-duplicated scope shape
 * in the codebase — the ingest pipeline (open/append/complete/recompute), the
 * run-detail loader, the test-detail loader, and the `/summary` + `/results`
 * API routes each hand-roll `and(eq(runs.projectId, …), eq(runs.id, runId))`.
 *
 * Scopes by `projectId` (not `teamId`) deliberately, matching the
 * `runs_project_idempotency_key_idx` / `runs_project_created_at_idx` access
 * paths: `runs.id` is a globally-unique ULID primary key, so `projectId`
 * alone is sufficient isolation — the row can't belong to another project.
 *
 * Brand load-bearing: requires a `TenantScope`, so the project id is
 * always auth-checked.
 */
export function runByIdWhere(scope: TenantScope, runId: string): SqlFragment {
  return and(eq(runs.projectId, scope.projectId), eq(runs.id, runId))!;
}

/**
 * The single definition of "this run is stuck" for the cron watchdog (and any
 * future admin force-complete / "stalled?" badge): a run still at
 * `status = 'running'` whose last ingest write predates `cutoffSeconds`.
 *
 * Keys off the `runs.lastActivityAt` liveness signal — bumped on every ingest
 * write — NOT `createdAt`, which is fixed at open. The old createdAt-only
 * predicate could not tell a long-but-live suite (still POSTing /results every
 * few seconds) from a process that died at onBegin, so it force-interrupted
 * live runs once they crossed the wall-clock window. Concentrating the
 * definition here means the next reader of "is this run dead?" can't re-derive
 * it from `createdAt` and re-introduce that false positive.
 *
 * `coalesce(lastActivityAt, createdAt)` keeps a run whose `lastActivityAt` is
 * somehow NULL (e.g. a row written before this column existed) comparable, so a
 * truly-dead onBegin-only run is still swept rather than skipped forever.
 */
export function staleRunFilter(cutoffSeconds: number): SqlFragment {
  return and(
    eq(runs.status, "running"),
    lt(sql`coalesce(${runs.lastActivityAt}, ${runs.createdAt})`, cutoffSeconds),
  )!;
}
