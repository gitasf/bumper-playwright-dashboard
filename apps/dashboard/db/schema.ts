// `sql` (from the side-effect-free `void/_db` entry, not `void/db` whose `db`
// export resolves the D1 binding) backs the `COALESCE(role, '')` expression in
// the artifacts unique index below — safe at schema-parse time and for
// `void db generate`.
import { sql } from "void/_db";
import { index, integer, sqliteTable, text, uniqueIndex } from "void/schema-d1";

export type MembershipRole = "owner" | "member";

/**
 * Single-D1 schema for the Void dashboard.
 *
 * Collapses what used to live across two Durable Objects:
 *   - `ControlDO` (auth + tenancy)
 *   - `TenantDO`  (per-team test data: runs and children)
 *
 * Better Auth's core tables (`user`, `session`, `account`, `verification`)
 * are **owned by Void** — they're bootstrapped by `void/auth`'s idempotent
 * migration runner against the same D1, with `CREATE TABLE IF NOT EXISTS`
 * semantics. They live in this database alongside our tables but are
 * intentionally NOT declared here so the two migration runners don't fight
 * over indexes/column shapes. Cross-table joins use raw SQL where needed;
 * the current-user context comes from `void/auth#getUser`/`getSession`.
 *
 * Tenant isolation moves from physical (one SQLite file per team) to
 * logical: every run-scoped query MUST filter by `teamId` AND `projectId`.
 * Run-scoped child tables carry both denormalized so query paths don't have
 * to join through `runs` to enforce scope (and so the brand-typed
 * `AuthorizedProjectId` can gate access without runtime joins).
 *
 * Identifiers are camelCase in both TS and SQL — matches Better Auth's
 * kysely-style field names.
 */

// ---------- Tenancy ----------

export const teams = sqliteTable(
  "teams",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    createdAt: integer("createdAt").notNull(),
    lastActivityAt: integer("lastActivityAt"),
  },
  (t) => [
    uniqueIndex("teams_slug_idx").on(t.slug),
    index("teams_lastActivityAt_idx").on(t.lastActivityAt),
  ],
);

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    teamId: text("teamId")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    createdAt: integer("createdAt").notNull(),
  },
  (t) => [uniqueIndex("projects_team_slug_idx").on(t.teamId, t.slug)],
);

/**
 * User → team join row. `userId` references the void-managed `user.id`
 * column but is declared without a Drizzle .references() call so this
 * schema can be migrated independently of void's auth bootstrap.
 */
export const memberships = sqliteTable(
  "memberships",
  {
    id: text("id").primaryKey(),
    userId: text("userId").notNull(),
    teamId: text("teamId")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    role: text("role").$type<MembershipRole>().notNull(),
    createdAt: integer("createdAt").notNull(),
  },
  (t) => [
    uniqueIndex("memberships_user_team_idx").on(t.userId, t.teamId),
    index("memberships_team_idx").on(t.teamId),
  ],
);

export const teamInvites = sqliteTable(
  "teamInvites",
  {
    id: text("id").primaryKey(),
    teamId: text("teamId")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    tokenHash: text("tokenHash").notNull(),
    role: text("role").$type<MembershipRole>().notNull(),
    /** `user.id` of the inviter. No .references() — see schema doc-comment. */
    createdBy: text("createdBy").notNull(),
    createdAt: integer("createdAt").notNull(),
    expiresAt: integer("expiresAt").notNull(),
    /** Directed invite: matched against the signed-in user's email. */
    email: text("email"),
    /**
     * Directed invite: matched against `userGithubAccounts.githubLogin` when
     * the invitee signs in via the GitHub provider.
     */
    githubLogin: text("githubLogin"),
  },
  (t) => [
    uniqueIndex("teamInvites_tokenHash_idx").on(t.tokenHash),
    index("teamInvites_team_idx").on(t.teamId),
    index("teamInvites_email_idx").on(t.email),
    index("teamInvites_githubLogin_idx").on(t.githubLogin),
  ],
);

/**
 * Captures the GitHub login (`@octocat`) for a user that signed in via the
 * GitHub OAuth provider. Better Auth's `account` row stores `accountId` (the
 * numeric id) but not the human-readable login, which we need to resolve
 * directed-by-github-handle invites. Populated by a sign-in hook in auth.ts.
 */
export const userGithubAccounts = sqliteTable(
  "userGithubAccounts",
  {
    /** void-managed `user.id`. Logical FK; not declared here. */
    userId: text("userId").primaryKey(),
    githubLogin: text("githubLogin").notNull(),
    updatedAt: integer("updatedAt").notNull(),
  },
  (t) => [index("userGithubAccounts_githubLogin_idx").on(t.githubLogin)],
);

/**
 * Per-user last-viewed state. Drives the post-login landing redirect and
 * "back to where you were" behavior across sessions. Soft-references project
 * + team so deletes don't break sign-in.
 */
export const userState = sqliteTable("userState", {
  userId: text("userId").primaryKey(),
  lastTeamId: text("lastTeamId").references(() => teams.id, {
    onDelete: "set null",
  }),
  lastProjectId: text("lastProjectId").references(() => projects.id, {
    onDelete: "set null",
  }),
  updatedAt: integer("updatedAt").notNull(),
});

// ---------- API keys ----------

export const apiKeys = sqliteTable(
  "apiKeys",
  {
    id: text("id").primaryKey(),
    projectId: text("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    /** SHA-256 hex of the raw key. Never store the plaintext key. */
    keyHash: text("keyHash").notNull(),
    /**
     * First 8 chars of the raw key. Lookup index — we hash-compare the rest
     * with constant time to avoid timing leaks across thousands of keys.
     */
    keyPrefix: text("keyPrefix").notNull(),
    createdAt: integer("createdAt").notNull(),
    lastUsedAt: integer("lastUsedAt"),
    revokedAt: integer("revokedAt"),
  },
  (t) => [
    index("apiKeys_project_idx").on(t.projectId),
    index("apiKeys_keyPrefix_idx").on(t.keyPrefix),
  ],
);

// ---------- Test data (runs and children) ----------

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    /**
     * Denormalized copy of `projects.teamId`. Two reasons it earns its row:
     *   1. Defense-in-depth for the `AuthorizedProjectId` brand — every
     *      scoped query filters by `(teamId, projectId)` so a leaked project
     *      id can't cross teams even if the brand check is bypassed.
     *   2. Single-hop authz on the live socket (`src/live.ts`): we resolve a
     *      subscriber's read access by `SELECT teamId FROM runs WHERE id = ?`
     *      then joining memberships, instead of hopping through projects.
     */
    teamId: text("teamId")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    projectId: text("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotencyKey"),
    ciProvider: text("ciProvider"),
    ciBuildId: text("ciBuildId"),
    branch: text("branch"),
    environment: text("environment"),
    commitSha: text("commitSha"),
    commitMessage: text("commitMessage"),
    prNumber: integer("prNumber"),
    repo: text("repo"),
    actor: text("actor"),
    totalTests: integer("totalTests").notNull(),
    expectedTotalTests: integer("expectedTotalTests"),
    passed: integer("passed").notNull(),
    failed: integer("failed").notNull(),
    flaky: integer("flaky").notNull(),
    skipped: integer("skipped").notNull(),
    durationMs: integer("durationMs").notNull(),
    status: text("status").notNull(),
    reporterVersion: text("reporterVersion"),
    playwrightVersion: text("playwrightVersion"),
    createdAt: integer("createdAt").notNull(),
    /**
     * Liveness signal: the epoch-seconds timestamp of the most recent ingest
     * write to this run. Initialized to `createdAt` at open (so an onBegin-only
     * dead run is still sweepable) and bumped to "now" in the SAME D1 batch as
     * every subsequent /results, /complete, and watchdog write — never a
     * separate round-trip.
     *
     * The cron watchdog (`crons/sweep-stuck-runs.ts`) keys off THIS, not
     * `createdAt`, via `staleRunFilter` (src/lib/scope.ts): "no write activity
     * for N minutes" is what 'stuck' actually means, so a legitimately long
     * suite that is still streaming results is no longer force-flipped to
     * 'interrupted'. Nullable for migration safety on rows that predate the
     * column; readers `coalesce(lastActivityAt, createdAt)` so a NULL is never
     * treated as "infinitely stale".
     */
    lastActivityAt: integer("lastActivityAt"),
    completedAt: integer("completedAt"),
  },
  (t) => [
    uniqueIndex("runs_project_idempotency_key_idx").on(
      t.projectId,
      t.idempotencyKey,
    ),
    index("runs_project_created_at_idx").on(t.projectId, t.createdAt),
    index("runs_project_branch_created_at_idx").on(
      t.projectId,
      t.branch,
      t.createdAt,
    ),
    index("runs_project_environment_created_at_idx").on(
      t.projectId,
      t.environment,
      t.createdAt,
    ),
    index("runs_project_actor_idx").on(t.projectId, t.actor),
    /**
     * Serves the watchdog sweep SELECT (`sweepStaleRuns` / `staleRunFilter`):
     * `status = 'running' AND coalesce(lastActivityAt, createdAt) < cutoff`.
     * Without it the sweep is a status-filtered table scan; this lets D1 seek
     * straight to the 'running' rows (a small slice in steady state) and walk
     * them in lastActivityAt order so the bounded `.limit` slice is cheap.
     * (Supersedes the perf-audit's partial `runs(createdAt) WHERE running`
     * index — the watchdog is now keyed on lastActivityAt, not createdAt.)
     */
    index("runs_status_lastActivityAt_idx").on(t.status, t.lastActivityAt),
  ],
);

export const testResults = sqliteTable(
  "testResults",
  {
    id: text("id").primaryKey(),
    projectId: text("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    runId: text("runId")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    testId: text("testId").notNull(),
    title: text("title").notNull(),
    file: text("file").notNull(),
    projectName: text("projectName"),
    status: text("status").notNull(),
    durationMs: integer("durationMs").notNull(),
    retryCount: integer("retryCount").notNull().default(0),
    errorMessage: text("errorMessage"),
    errorStack: text("errorStack"),
    workerIndex: integer("workerIndex"),
    createdAt: integer("createdAt").notNull(),
  },
  (t) => [
    index("testResults_testId_createdAt_idx").on(t.testId, t.createdAt),
    // NB: no standalone (runId) or (status, createdAt) index — (runId) is a
    // prefix of the unique (runId, testId) below, and no query filters by
    // `status` as a leading predicate (it's a low-cardinality CASE column).
    // See docs/worklog/2026-05-29-db-performance-audit.md §2/§3.A/§3.B.
    uniqueIndex("testResults_runId_testId_idx").on(t.runId, t.testId),
    index("testResults_project_runId_idx").on(t.projectId, t.runId),
    // Backs the analytics surface (flaky / tests / slowest / suite-size), all
    // of which filter by (projectId, createdAt). Without it those queries scan
    // the whole project partition via testResults_project_runId_idx.
    index("testResults_project_createdAt_idx").on(t.projectId, t.createdAt),
    // Covering index for the tests-catalog list: WHERE projectId = ? AND
    // createdAt >= ? GROUP BY testId is served project-scoped from the index
    // with the group satisfied by index order (no temp b-tree). See worklog §3.E.
    index("testResults_project_testId_createdAt_idx").on(
      t.projectId,
      t.testId,
      t.createdAt,
    ),
  ],
);

export const testTags = sqliteTable(
  "testTags",
  {
    id: text("id").primaryKey(),
    projectId: text("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    testResultId: text("testResultId")
      .notNull()
      .references(() => testResults.id, { onDelete: "cascade" }),
    tag: text("tag").notNull(),
  },
  (t) => [
    // No standalone (tag) index — nothing filters `WHERE tag = ?`; the only tag
    // reads group by tag from a testResults-driven scan. Re-add (projectId, tag)
    // if a tag-filter feature lands. See worklog §2.
    index("testTags_testResultId_idx").on(t.testResultId),
  ],
);

export const testAnnotations = sqliteTable(
  "testAnnotations",
  {
    id: text("id").primaryKey(),
    projectId: text("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    testResultId: text("testResultId")
      .notNull()
      .references(() => testResults.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    description: text("description"),
  },
  (t) => [index("testAnnotations_testResultId_idx").on(t.testResultId)],
);

export const testResultAttempts = sqliteTable(
  "testResultAttempts",
  {
    id: text("id").primaryKey(),
    projectId: text("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    testResultId: text("testResultId")
      .notNull()
      .references(() => testResults.id, { onDelete: "cascade" }),
    attempt: integer("attempt").notNull(),
    status: text("status").notNull(),
    durationMs: integer("durationMs").notNull(),
    errorMessage: text("errorMessage"),
    errorStack: text("errorStack"),
    createdAt: integer("createdAt").notNull(),
  },
  (t) => [
    // No standalone (testResultId) index — it's a prefix of the unique
    // (testResultId, attempt) below, which serves every testResultId-leading
    // access (reads + the ingest delete + FK cascade). See worklog §2/§3.A.
    uniqueIndex("testResultAttempts_testResultId_attempt_uq").on(
      t.testResultId,
      t.attempt,
    ),
  ],
);

export const artifacts = sqliteTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    projectId: text("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    testResultId: text("testResultId")
      .notNull()
      .references(() => testResults.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    name: text("name").notNull(),
    contentType: text("contentType").notNull(),
    sizeBytes: integer("sizeBytes").notNull(),
    /**
     * R2 object key. Built by `buildArtifactR2Key` in `src/lib/artifacts.ts`:
     * `t/<teamId>/p/<projectId>/runs/<runId>/<testResultId>/<artifactId>/<safe-filename>`.
     */
    r2Key: text("r2Key").notNull(),
    attempt: integer("attempt").notNull().default(0),
    /**
     * Visual-regression role. One of "expected" | "actual" | "diff" when the
     * artifact came from a screenshot assertion; null otherwise.
     */
    role: text("role"),
    /**
     * Shared name used to group the three sibling images of a visual
     * regression failure (sent alongside `role`); null for non-snapshot
     * artifacts. Not part of the idempotency identity below.
     */
    snapshotName: text("snapshotName"),
    createdAt: integer("createdAt").notNull(),
  },
  (t) => [
    index("artifacts_testResultId_idx").on(t.testResultId),
    /**
     * Artifact idempotency identity. A retried `/results` flush re-registers
     * the same artifact set; this tuple is what makes two registrations "the
     * same artifact" so the reporter's PUT overwrites one R2 object instead of
     * minting a duplicate row + double-billing storage/egress. It is the DB
     * mirror of `artifactIdentity()` in `src/lib/artifacts.ts` — keep the two
     * in sync (e.g. if `snapshotName` ever joins the identity for visual diffs,
     * add it to BOTH). `role` is nullable and SQLite treats NULLs as distinct
     * in unique indexes, which would let role-less artifacts (the common case)
     * dodge the constraint; `COALESCE(role, '')` collapses NULL to the empty
     * string exactly as `artifactIdentity` does (`role ?? ""`) so the index
     * enforces the same identity the application dedupes on and closes the
     * lookup-before-insert race window.
     */
    uniqueIndex("artifacts_identity_uq").on(
      t.projectId,
      t.testResultId,
      t.type,
      t.name,
      t.attempt,
      sql`COALESCE(${t.role}, '')`,
    ),
  ],
);

// ---------- Type aliases for downstream code ----------

export type Team = typeof teams.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type Membership = typeof memberships.$inferSelect;
export type TeamInvite = typeof teamInvites.$inferSelect;
export type UserGithubAccount = typeof userGithubAccounts.$inferSelect;
export type UserStateRow = typeof userState.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type TestResult = typeof testResults.$inferSelect;
export type TestTag = typeof testTags.$inferSelect;
export type TestAnnotation = typeof testAnnotations.$inferSelect;
export type TestResultAttempt = typeof testResultAttempts.$inferSelect;
export type Artifact = typeof artifacts.$inferSelect;
