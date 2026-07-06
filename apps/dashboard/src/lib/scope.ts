import { and, db, eq, inArray, lt, ne } from "void/db";
import { projects, runs, teams } from "@schema";
import type { ApiKey } from "@schema";

/**
 * A Drizzle column reference, as `eq` accepts it. Derived from `eq`'s own
 * first-parameter type so the child-predicate family below stays table-agnostic
 * (it works for any run-scoped child table's column) without importing
 * Drizzle's internal `PgColumn` type.
 */
type ColumnRef = Parameters<typeof eq>[0];

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
 * {@link runScopeWhere} plus the CI-analytics policy clause:
 * `runs.origin <> 'synthetic'`. The Drizzle-side home for "this query reads CI
 * history, not monitor traffic" — a 1-minute synthetic monitor writes 1,440
 * runs/day that would otherwise dominate every aggregate computed over the
 * `runs` table (insights KPIs/buckets, suite-size trend, run-duration
 * percentiles, branch filter options).
 *
 * `ne('synthetic')` rather than `eq('ci')` so any future origin value counts
 * as CI-like by default; only monitor traffic is carved out. Raw-SQL analytics
 * passes get the same policy from `testResultsScopeJoin` /
 * `ciRunsJoinFragment` in `@/lib/analytics/filters`.
 *
 * Deliberately NOT folded into {@link runScopeWhere} or {@link runByIdWhere}:
 * run-detail-by-id paths (and the runs list, whose origin filter is
 * user-controlled via `scopedRunsWhere`) must still see synthetic runs.
 */
export function ciRunsScopeWhere(scope: TenantScope): SqlFragment {
  return and(runScopeWhere(scope), ne(runs.origin, "synthetic"))!;
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
 * The blessed tenant-predicate family for the run-scoped CHILD tables
 * (`testResults`, `testResultAttempts`, `testTags`, `testAnnotations`,
 * `artifacts`, plus the project-scoped `monitors` / `monitorExecutions` /
 * `quarantinedTests`). Each of these tables carries a denormalized `projectId`
 * column *precisely so* scope is enforced WITHOUT joining back through `runs`
 * (see the schema comment on the run-scoped child tables) — the security
 * convention "scope a child by its own `projectId`, never by joining through
 * `runs`" lives here as code instead of as repeated prose at ~two dozen sites.
 *
 * The whole family is parameterized by the child table's relevant column(s) so
 * one definition serves every child table. Each takes a `TenantScope`, so the
 * predicate can ONLY originate from an auth-checked project id — a raw `string`
 * projectId won't type, exactly as for the `runs` family above. This is a
 * locality + testability + forward-brand consolidation: the emitted predicate
 * is identical to the hand-rolled `eq(<child>.projectId, scope.projectId)` it
 * replaces.
 */

/**
 * The bare project-scope predicate for a simple child read: `projectId = ?`,
 * bound to the scope's auth-checked id. The single-column member of the family,
 * for the index-only / list reads that scope by `projectId` alone
 * (`loadProjectTags`, `listMonitors`, `listQuarantine`, the by-`type` count).
 */
export function childProjectScopeWhere(
  projectIdColumn: ColumnRef,
  scope: TenantScope,
): SqlFragment {
  return eq(projectIdColumn, scope.projectId);
}

/**
 * The `(projectId, testResultId)` shape — a child row addressed by its parent
 * test result within the tenant. The most-duplicated child predicate: the
 * artifact-presentation reads, the test-detail loader's tags / annotations /
 * attempts reads, and the upload-validation read all AND exactly this pair.
 */
export function childByTestResultWhere(
  columns: { projectId: ColumnRef; testResultId: ColumnRef },
  scope: TenantScope,
  testResultId: string,
): SqlFragment {
  return and(
    eq(columns.projectId, scope.projectId),
    eq(columns.testResultId, testResultId),
  )!;
}

/**
 * The `(projectId, testResultId IN (…))` shape — the batched sibling of
 * {@link childByTestResultWhere} for replacing the child rows of MANY test
 * results in one statement (the /results flush's tag/annotation/attempt
 * DELETEs). Callers chunk `testResultIds` under Postgres's bound-param ceiling;
 * an empty list yields a predicate that matches nothing (`inArray([])` → false),
 * so a no-child flush deletes nothing.
 */
export function childByTestResultsWhere(
  columns: { projectId: ColumnRef; testResultId: ColumnRef },
  scope: TenantScope,
  testResultIds: string[],
): SqlFragment {
  return and(
    eq(columns.projectId, scope.projectId),
    inArray(columns.testResultId, testResultIds),
  )!;
}

/**
 * The `(projectId, runId)` shape — a child row addressed by its owning run
 * within the tenant. Used by the run-diff per-test status read and the
 * run-results page query (both over `testResults`).
 */
export function childByRunWhere(
  columns: { projectId: ColumnRef; runId: ColumnRef },
  scope: TenantScope,
  runId: string,
): SqlFragment {
  return and(eq(columns.projectId, scope.projectId), eq(columns.runId, runId))!;
}

/**
 * The `(projectId, testId)` shape — a child row addressed by the stable
 * `testId` within the tenant (the `quarantinedTests` / `testOwners` unique
 * index). Folds the private `quarantineByTestIdWhere` near-clone of
 * {@link runByIdWhere} into the family.
 */
export function childByTestIdWhere(
  columns: { projectId: ColumnRef; testId: ColumnRef },
  scope: TenantScope,
  testId: string,
): SqlFragment {
  return and(
    eq(columns.projectId, scope.projectId),
    eq(columns.testId, testId),
  )!;
}

/**
 * The `(projectId, id)` shape — a child row addressed by its own globally
 * unique ULID primary key within the tenant. Same isolation argument as
 * {@link runByIdWhere}: the id can't belong to another project, so `projectId`
 * alone is sufficient. Folds the private `monitorByIdWhere` near-clone into the
 * family (`monitors` / `monitorExecutions` by-id reads + writes).
 */
export function childByIdWhere(
  columns: { projectId: ColumnRef; id: ColumnRef },
  scope: TenantScope,
  id: string,
): SqlFragment {
  return and(eq(columns.projectId, scope.projectId), eq(columns.id, id))!;
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
 * `lastActivityAt` is NOT NULL (initialized to `createdAt` at open, bumped on
 * every write), so it is compared directly — the old `coalesce(lastActivityAt,
 * createdAt)` fallback for pre-column rows is gone (those rows were backfilled
 * when the column was tightened; see `docs/schema-rework-plan.md` Phase 4).
 */
export function staleRunFilter(cutoffSeconds: number): SqlFragment {
  return and(
    eq(runs.status, "running"),
    lt(runs.lastActivityAt, cutoffSeconds),
  )!;
}
