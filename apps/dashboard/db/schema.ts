// Hand-authored Postgres (pg-core) schema — the single source of truth for the
// dashboard's tenant/control tables. Migrations are generated from THIS file via
// `pnpm db:generate` (= `void db generate`) into `db/migrations/`. Edit the table
// definitions here, then regenerate; never hand-edit the generated migrations.

// `sql` (from the side-effect-free `void/_db` entry, not `void/db` whose `db`
// export resolves the Postgres binding) backs the `COALESCE(role, '')` expression
// in the artifacts unique index below — safe at schema-parse time and for
// `void db generate`.
import { sql } from "void/_db";
import {
  bigint,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "void/schema-pg";

/** epoch-seconds / external 64-bit ids / cumulative counters — these use bigint. */
const big = (name: string) => bigint(name, { mode: "number" });

/**
 * A user's role within a team. The column is `text().$type<MembershipRole>()`,
 * so widening this union (roadmap 3.1: adding `"viewer"`) is a pure TYPE change
 * with NO migration — Postgres stores it as text either way. Capability gating
 * lives in `src/lib/roles.ts` (`can(role, action)`), not in the column type.
 */
export type MembershipRole = "owner" | "member" | "viewer";

/**
 * Postgres schema for the Void dashboard.
 *
 * Collapses what used to live across two Durable Objects:
 *   - `ControlDO` (auth + tenancy)
 *   - `TenantDO`  (per-team test data: runs and children)
 *
 * Better Auth's core tables (`user`, `session`, `account`, `verification`)
 * are **owned by Void** — they're bootstrapped idempotently by `void/auth`
 * against the same database. They live in this database alongside our tables
 * but are intentionally NOT declared here so the two migration runners don't
 * fight over indexes/column shapes. Cross-table joins use raw SQL where needed;
 * the current-user context comes from `void/auth#getUser`/`getSession`.
 *
 * Tenant isolation is logical, not physical: a single shared Postgres store
 * holds every team's data and every run-scoped query MUST filter by `teamId`
 * AND `projectId`. Run-scoped child tables carry both denormalized so query
 * paths don't have to join through `runs` to enforce scope (and so the
 * brand-typed `AuthorizedProjectId` can gate access without runtime joins).
 *
 * Identifiers are camelCase in both TS and SQL — matches Better Auth's
 * kysely-style field names.
 */

// ---------- Tenancy ----------

export const teams = pgTable(
  "teams",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    createdAt: big("createdAt").notNull(),
    lastActivityAt: big("lastActivityAt"),
    /**
     * Billing tier — drives which limit set `checkQuota` (`src/lib/usage.ts`)
     * enforces. `'free'` (default) → the env-configured `WRIGHTFUL_FREE_*`
     * ceilings; any other tier is treated as unlimited (no quota block). Stripe
     * binding (a `stripeCustomerId` column flipped by a webhook) is a later,
     * additive change — the metering + enforcement layer is tier-agnostic.
     */
    tier: text("tier").notNull().default("free"),
    /**
     * Two-axis data-retention windows in DAYS, both nullable (null → the
     * `WRIGHTFUL_RETENTION_*` env default). Separate because the cost/value
     * profiles differ: `retentionArtifactDays` bounds R2 bytes (the storage
     * cost), `retentionTestResultsDays` bounds the testResults row history
     * (Postgres size). The `sweep-retention` cron enforces both. The artifact
     * window must
     * stay ≤ the testResults window (validated in the settings editor) so an
     * expiring testResult's FK cascade never orphans still-live R2 objects.
     */
    retentionArtifactDays: integer("retentionArtifactDays"),
    retentionTestResultsDays: integer("retentionTestResultsDays"),
  },
  (t) => [
    uniqueIndex("teams_slug_idx").on(t.slug),
    index("teams_lastActivityAt_idx").on(t.lastActivityAt),
  ],
);

export const projects = pgTable(
  "projects",
  {
    id: text("id").primaryKey(),
    teamId: text("teamId")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    createdAt: big("createdAt").notNull(),
    /**
     * The project's CODEOWNERS file contents, source of the CODEOWNERS-derived
     * leg of test ownership (roadmap 2.3). Populated automatically from the
     * reporter at `onBegin` (it reads the repo's CODEOWNERS off disk and sends
     * it on the open-run payload — see `openRun`), and editable as a manual
     * paste fallback in project settings. Null until first seen. `matchOwners`
     * (`src/lib/codeowners.ts`) matches each test's `file` against this to
     * derive owners; manual `testOwners` rows override the derived set.
     */
    codeownersFile: text("codeownersFile"),
    /** Epoch-seconds the `codeownersFile` was last set (manually or via ingest). */
    codeownersUpdatedAt: big("codeownersUpdatedAt"),
  },
  (t) => [uniqueIndex("projects_team_slug_idx").on(t.teamId, t.slug)],
);

/**
 * User → team join row. `userId` references the void-managed `user.id`
 * column but is declared without a Drizzle .references() call so this
 * schema can be migrated independently of void's auth bootstrap.
 */
export const memberships = pgTable(
  "memberships",
  {
    id: text("id").primaryKey(),
    userId: text("userId").notNull(),
    teamId: text("teamId")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    role: text("role").$type<MembershipRole>().notNull(),
    createdAt: big("createdAt").notNull(),
  },
  (t) => [
    uniqueIndex("memberships_user_team_idx").on(t.userId, t.teamId),
    index("memberships_team_idx").on(t.teamId),
  ],
);

export const teamInvites = pgTable(
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
    createdAt: big("createdAt").notNull(),
    expiresAt: big("expiresAt").notNull(),
    /** Directed invite: matched against the signed-in user's email. */
    email: text("email"),
    /**
     * Directed invite: matched against `userGithubAccounts.githubLogin` when
     * the invitee signs in via the GitHub provider. SECURITY: matched ONLY on
     * the secret `/invite/:token` share-link path (as a second factor behind
     * the token) — never on the tokenless picker/accept/decline path, because
     * a GitHub login is mutable/reusable and a freed handle could otherwise be
     * re-registered to hijack the invite. See `buildInviteMatchConds`.
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
 * A named, team-scoped group of members — a reusable primitive for addressing
 * subsets of a team. Initially the targets of monitor alerts (a monitor's
 * `alertTargets` may reference groups), but intentionally generic so other
 * features (notification routing, access scoping) can reuse it. Team-scoped
 * because membership is team-scoped; a group can only contain members of its
 * own team (enforced at write time + re-intersected at read time).
 */
export const memberGroups = pgTable(
  "memberGroups",
  {
    id: text("id").primaryKey(),
    teamId: text("teamId")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** `user.id` of the creator. Logical FK — see schema header. */
    createdBy: text("createdBy").notNull(),
    createdAt: big("createdAt").notNull(),
    updatedAt: big("updatedAt").notNull(),
  },
  (t) => [uniqueIndex("memberGroups_team_name_idx").on(t.teamId, t.name)],
);

/**
 * Group ↔ member join row. `userId` is a logical ref to the void-owned
 * `user.id` (no `.references()`, like `memberships.userId`). Cascade-deletes
 * with the group; a member leaving the team is dropped by the
 * `setGroupMembers` write (and re-intersected with live members on read).
 */
export const memberGroupMembers = pgTable(
  "memberGroupMembers",
  {
    groupId: text("groupId")
      .notNull()
      .references(() => memberGroups.id, { onDelete: "cascade" }),
    userId: text("userId").notNull(),
  },
  // The composite primary key's index covers all groupId-prefixed lookups
  // (listGroups, listUserIdsInGroups, replaceMembers' delete), so no separate
  // single-column index is needed.
  (t) => [primaryKey({ columns: [t.groupId, t.userId] })],
);

/**
 * Captures the GitHub login (`@octocat`) for a user that signed in via the
 * GitHub OAuth provider. Better Auth's `account` row stores `accountId` (the
 * numeric id) but not the human-readable login, which we need to resolve
 * directed-by-github-handle invites. Populated by a sign-in hook in auth.ts.
 */
export const userGithubAccounts = pgTable(
  "userGithubAccounts",
  {
    /** void-managed `user.id`. Logical FK; not declared here. */
    userId: text("userId").primaryKey(),
    githubLogin: text("githubLogin").notNull(),
    updatedAt: big("updatedAt").notNull(),
  },
  (t) => [index("userGithubAccounts_githubLogin_idx").on(t.githubLogin)],
);

/**
 * Per-user last-viewed state. Drives the post-login landing redirect and
 * "back to where you were" behavior across sessions. Soft-references project
 * + team so deletes don't break sign-in.
 */
export const userState = pgTable("userState", {
  userId: text("userId").primaryKey(),
  lastTeamId: text("lastTeamId").references(() => teams.id, {
    onDelete: "set null",
  }),
  lastProjectId: text("lastProjectId").references(() => projects.id, {
    onDelete: "set null",
  }),
  updatedAt: big("updatedAt").notNull(),
});

// ---------- API keys ----------

export const apiKeys = pgTable(
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
    createdAt: big("createdAt").notNull(),
    lastUsedAt: big("lastUsedAt"),
    revokedAt: big("revokedAt"),
  },
  (t) => [
    index("apiKeys_project_idx").on(t.projectId),
    index("apiKeys_keyPrefix_idx").on(t.keyPrefix),
  ],
);

// ---------- Billing / usage metering ----------

/**
 * Per-team usage meter, one row per (team, calendar-month). The live counter
 * the ingest pipeline increments in the SAME transaction as its writes
 * (`usageBumpStatement` in `src/lib/usage.ts`) — so a run open / results flush /
 * artifact registration bumps usage atomically with the data it meters, never a
 * separate round-trip. `periodStart` is the UTC month-boundary epoch-seconds
 * (`monthStartSeconds`), so a new month lands on a fresh row via the upsert's
 * `onConflictDoUpdate` — no reset job. `checkQuota` reads the current row to
 * gate ingest against the team's tier limits; the `rollup-usage` cron
 * recomputes a period's counters from the authoritative rows to correct drift.
 */
export const usageCounters = pgTable(
  "usageCounters",
  {
    id: text("id").primaryKey(),
    teamId: text("teamId")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    /** UTC start-of-month epoch-seconds — the rolling billing window key. */
    periodStart: big("periodStart").notNull(),
    runsCount: integer("runsCount").notNull().default(0),
    testResultsCount: integer("testResultsCount").notNull().default(0),
    artifactBytes: big("artifactBytes").notNull().default(0),
    artifactCount: integer("artifactCount").notNull().default(0),
    updatedAt: big("updatedAt").notNull(),
  },
  (t) => [
    // The upsert conflict target AND the seek key for `checkQuota` /
    // `loadTeamUsage` ("this team's row for this period").
    uniqueIndex("usageCounters_team_period_idx").on(t.teamId, t.periodStart),
  ],
);

// ---------- GitHub App (check runs) ----------

/**
 * A GitHub App installation linked to a Wrightful team. Created by the setup
 * callback (`routes/api/github/setup.ts`, which knows the team from the install
 * `state`) and removed by the `installation.deleted` webhook. `accountLogin` is
 * the org/user the App is installed on — the resolution key from a run's
 * `repo` ("owner/name") to the installation that can post a check on it.
 */
export const githubInstallations = pgTable(
  "githubInstallations",
  {
    id: text("id").primaryKey(),
    teamId: text("teamId")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    /** GitHub's numeric installation id — what we mint installation tokens for. */
    installationId: big("installationId").notNull(),
    /** The org/user login the App is installed on (the `repo` owner segment). */
    accountLogin: text("accountLogin").notNull(),
    createdAt: big("createdAt").notNull(),
    updatedAt: big("updatedAt").notNull(),
  },
  (t) => [
    uniqueIndex("githubInstallations_installationId_idx").on(t.installationId),
    // Resolve "which installation can post a check for repo owner X" without a
    // scan. Account logins are unique per installation, so this is a point seek.
    uniqueIndex("githubInstallations_accountLogin_idx").on(t.accountLogin),
    index("githubInstallations_team_idx").on(t.teamId),
  ],
);

// ---------- Test data (runs and children) ----------

export const runs = pgTable(
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
    createdAt: big("createdAt").notNull(),
    /**
     * Liveness signal: the epoch-seconds timestamp of the most recent ingest
     * write to this run. Initialized to `createdAt` at open (so an onBegin-only
     * dead run is still sweepable) and bumped to "now" in the SAME transaction
     * as every subsequent /results, /complete, and watchdog write — never a
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
    lastActivityAt: big("lastActivityAt"),
    completedAt: big("completedAt"),
    /**
     * Where this run came from. `'ci'` (default) — a normal reporter run from
     * CI/local. `'synthetic'` — produced by a scheduled synthetic monitor (see
     * `monitors`). Lets the runs list / insights include or separate synthetic
     * traffic. Existing rows default to `'ci'`.
     */
    origin: text("origin").notNull().default("ci"),
    /**
     * For `origin = 'synthetic'`, the `monitors.id` this run belongs to. A
     * LOGICAL foreign key (no `.references()`) — declared without a Drizzle FK
     * to avoid a `runs` ↔ `monitors` cascade cycle in the generated migration,
     * matching the existing logical-FK precedent (`memberships.userId`). Null
     * for CI runs. A deleted monitor cascades its `monitorExecutions`; the run
     * itself is retained with a dangling `monitorId` (harmless — readers treat
     * a missing monitor gracefully).
     */
    monitorId: text("monitorId"),
    /**
     * The GitHub check-run id created for this run, or null. Lets the terminal
     * path (`completeRun` / `finalizeStaleRun` → `maybePostGithubCheck`) PATCH
     * the existing check on a re-complete instead of POSTing a duplicate.
     */
    githubCheckRunId: big("githubCheckRunId"),
  },
  (t) => [
    uniqueIndex("runs_project_idempotency_key_idx").on(
      t.projectId,
      t.idempotencyKey,
    ),
    // Reserved for the upcoming "runs for this monitor" list — no read uses it
    // yet (the only `monitorId` touch today is the ingest write). Pure write
    // amplification until that query lands; drop it if the feature is cut.
    index("runs_project_monitor_created_at_idx").on(
      t.projectId,
      t.monitorId,
      t.createdAt,
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
     * Without it the sweep is a status-filtered table scan; this lets Postgres
     * seek straight to the 'running' rows (a small slice in steady state) and walk
     * them in lastActivityAt order so the bounded `.limit` slice is cheap.
     * (Supersedes the perf-audit's partial `runs(createdAt) WHERE running`
     * index — the watchdog is now keyed on lastActivityAt, not createdAt.)
     */
    index("runs_status_lastActivityAt_idx").on(t.status, t.lastActivityAt),
  ],
);

export const testResults = pgTable(
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
    createdAt: big("createdAt").notNull(),
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

export const testTags = pgTable(
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
    index("testTags_testResultId_idx").on(t.testResultId),
    // Serves the tag-filter feature: `loadProjectTags`' `SELECT DISTINCT tag
    // WHERE projectId = ?` runs as an index-only skip-scan, and the EXISTS
    // tag-filter subquery (`tagFragment`) has a covering lookup. (The schema
    // pre-authorized this once a tag-filter feature landed — it now has.)
    index("testTags_project_tag_idx").on(t.projectId, t.tag),
  ],
);

export const testAnnotations = pgTable(
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

export const testResultAttempts = pgTable(
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
    createdAt: big("createdAt").notNull(),
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

export const artifacts = pgTable(
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
    createdAt: big("createdAt").notNull(),
  },
  (t) => [
    index("artifacts_testResultId_idx").on(t.testResultId),
    /**
     * Serves the retention sweep's age scan (`projectId = ? AND createdAt < ?`):
     * lets Postgres seek the project's oldest artifacts in createdAt order for the
     * bounded delete slice, instead of scanning the project partition via
     * `artifacts_testResultId_idx`. Mirrors `testResults_project_createdAt_idx`.
     */
    index("artifacts_project_createdAt_idx").on(t.projectId, t.createdAt),
    /**
     * Artifact idempotency identity. A retried `/results` flush re-registers
     * the same artifact set; this tuple is what makes two registrations "the
     * same artifact" so the reporter's PUT overwrites one R2 object instead of
     * minting a duplicate row + double-billing storage/egress. It is the DB
     * mirror of `artifactIdentity()` in `src/lib/artifacts.ts` — keep the two
     * in sync (e.g. if `snapshotName` ever joins the identity for visual diffs,
     * add it to BOTH). `role` is nullable and Postgres treats NULLs as distinct
     * in unique indexes (by default), which would let role-less artifacts (the common case)
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

// ---------- Synthetic monitoring ----------

/**
 * A synthetic monitor: user-authored Playwright (v1: `type = 'browser'`) run on
 * a schedule. Reserved `type`s ('http' | 'tcp' | 'ping') let the later
 * Checkly-style uptime family reuse this row + the scheduler + execution record
 * with a lighter executor. Run-scoped: carries denormalized `teamId` AND
 * `projectId` like `runs`, so tenant isolation needs no join.
 */
export const monitors = pgTable(
  "monitors",
  {
    id: text("id").primaryKey(),
    teamId: text("teamId")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    projectId: text("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Discriminator: 'browser' (v1). Reserved: 'http' | 'tcp' | 'ping'. */
    type: text("type").notNull(),
    /** 0/1 — paused monitors keep their row but are skipped by the sweep. */
    enabled: integer("enabled").notNull().default(1),
    /**
     * 0/1 — whether down/recovery email alerts fire for this monitor (on by
     * default). Sends require an email sender configured (`EMAIL_FROM`); with
     * none, alerting is a graceful no-op regardless. Edge-triggered on a
     * healthy↔down transition — see `src/lib/monitors/alerts.ts`.
     */
    alertsEnabled: integer("alertsEnabled").notNull().default(1),
    /**
     * Who alerts notify, as JSON. `null` = ALL team members (the default). A
     * `{ users: string[], groups: string[] }` object = those specific members +
     * the members of those `memberGroups`, unioned and re-intersected with live
     * memberships at send time. Parsing/expansion: `src/lib/monitors/alert-targets.ts`.
     */
    alertTargets: text("alertTargets"),
    /** Playwright spec source for `type = 'browser'`; null for non-browser types. */
    source: text("source"),
    /** Type-specific config as JSON (e.g. browser: timeout/workers; http: url/assertions). */
    config: text("config"),
    intervalSeconds: integer("intervalSeconds").notNull(),
    /** 'round_robin' | 'parallel' — reserved for multi-location; v1 single origin. */
    schedulingStrategy: text("schedulingStrategy")
      .notNull()
      .default("round_robin"),
    /** Retries/anti-flapping config as JSON. Reserved (not consumed in v1). */
    retryConfig: text("retryConfig"),
    /**
     * Epoch-seconds of the next due execution; the sweep's seek key. Null means
     * "not scheduled" (paused / never armed). Advanced transactionally in the
     * sweep's transaction BEFORE enqueue so a double cron tick can't double-fire.
     */
    nextRunAt: big("nextRunAt"),
    lastEnqueuedAt: big("lastEnqueuedAt"),
    lastRunAt: big("lastRunAt"),
    /** Terminal state of the most recent execution: pass|degraded|fail|error|running. */
    lastStatus: text("lastStatus"),
    /** void-managed `user.id` of the creator. Logical FK — see schema header. */
    createdBy: text("createdBy").notNull(),
    createdAt: big("createdAt").notNull(),
    updatedAt: big("updatedAt").notNull(),
  },
  (t) => [
    uniqueIndex("monitors_project_name_idx").on(t.projectId, t.name),
    index("monitors_project_created_at_idx").on(t.projectId, t.createdAt),
    /**
     * The sweep SELECT (`enabled = 1 AND nextRunAt <= cutoff`) seeks straight to
     * the due slice and walks it in nextRunAt order, mirroring how
     * `runs_status_lastActivityAt_idx` serves the stuck-run watchdog.
     */
    index("monitors_enabled_next_run_at_idx").on(t.enabled, t.nextRunAt),
  ],
);

/**
 * One row per scheduled attempt of a monitor. For `type = 'browser'`, `runId`
 * links to the full `runs` row the in-container reporter streamed (so the rich
 * run/test UI is reused); lighter uptime types fill result fields inline (added
 * later). `runId` is a LOGICAL ref (no `.references()`) to avoid a FK cycle and
 * so a deleted run leaves the execution row intact with a null link.
 */
export const monitorExecutions = pgTable(
  "monitorExecutions",
  {
    id: text("id").primaryKey(),
    projectId: text("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    monitorId: text("monitorId")
      .notNull()
      .references(() => monitors.id, { onDelete: "cascade" }),
    scheduledFor: big("scheduledFor").notNull(),
    startedAt: big("startedAt"),
    completedAt: big("completedAt"),
    /** queued | running | pass | degraded | fail | error. */
    state: text("state").notNull(),
    attempt: integer("attempt").notNull().default(0),
    /** Logical ref to `runs.id` for browser executions; null otherwise. */
    runId: text("runId"),
    durationMs: integer("durationMs"),
    /**
     * HTTP response status code for `http` (uptime) executions; null for browser
     * and for `http` checks that never got a response (network error / timeout).
     * Stored as a queryable column (vs buried in `resultDetail`) so the list /
     * timeline can show + filter by it without parsing JSON.
     */
    statusCode: integer("statusCode"),
    /**
     * Inline result detail for `http` executions as JSON (`HttpResultDetail`):
     * per-assertion outcomes, timing phases, redirect chain, and a capped body
     * excerpt on a failed body assertion. Null for browser executions (whose
     * detail lives in the linked `runs` row).
     */
    resultDetail: text("resultDetail"),
    errorMessage: text("errorMessage"),
    createdAt: big("createdAt").notNull(),
  },
  (t) => [
    index("monitorExecutions_monitor_created_at_idx").on(
      t.monitorId,
      t.createdAt,
    ),
    index("monitorExecutions_project_created_at_idx").on(
      t.projectId,
      t.createdAt,
    ),
    /**
     * Serves the stuck-execution reaper SELECT (`sweepStaleExecutions`):
     * `state IN ('queued','running') AND createdAt < cutoff` ORDER BY createdAt.
     * Mirrors how `runs_status_lastActivityAt_idx` serves the stuck-run watchdog
     * — without it the reaper is a state-filtered table scan; this lets Postgres
     * seek the small non-terminal slice in steady state and walk it in createdAt order.
     */
    index("monitorExecutions_state_created_at_idx").on(t.state, t.createdAt),
  ],
);

/**
 * Per-project flaky-test quarantine list, keyed by the stable `testId`.
 *
 * The reporter pulls this at `onBegin` (`GET /api/runs/quarantine`) and, for v1
 * enforcement, DEMOTES a quarantined test's hard failure to `skipped` on the
 * wire so a known-flaky test can't redden a run while it's being stabilised
 * (a reporter is observe-only — it can't skip execution). The dashboard UI
 * (flaky + tests catalog) lets an owner add/remove entries.
 *
 * Like `testTags`, every row carries denormalized `projectId` so tenant
 * isolation needs no join. `createdBy` is the void-managed `user.id` of the
 * actor — a LOGICAL FK (no `.references()`), matching `monitors.createdBy`.
 */
export const quarantinedTests = pgTable(
  "quarantinedTests",
  {
    id: text("id").primaryKey(),
    projectId: text("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    testId: text("testId").notNull(),
    /** Optional human note explaining why the test is quarantined. */
    reason: text("reason"),
    /**
     * 'skip' (v1 default): demote a quarantined hard failure to `skipped` so it
     * doesn't count as a failure. 'soft': reserved for a future "still report
     * the failure but don't fail the run" mode (not enforced differently in v1).
     */
    mode: text("mode").notNull().$type<"skip" | "soft">().default("skip"),
    /** void-managed `user.id` of the creator. Logical FK — see schema header. */
    createdBy: text("createdBy").notNull(),
    createdAt: big("createdAt").notNull(),
  },
  (t) => [
    // One quarantine entry per (project, test). Re-quarantining the same test
    // upserts onto this index (mode/reason updated) rather than erroring.
    uniqueIndex("quarantinedTests_project_testId_idx").on(
      t.projectId,
      t.testId,
    ),
    // Backs the project-scoped list (`projectId = ?` ordered by `createdAt`).
    index("quarantinedTests_project_createdAt_idx").on(
      t.projectId,
      t.createdAt,
    ),
  ],
);

/**
 * Per-project test ownership, keyed by the stable `testId` (roadmap 2.3).
 *
 * Layered with two sources. A `source = 'manual'` row is an explicit
 * assignment made from the flaky page (owner-gated) — the SOURCE OF TRUTH, it
 * overrides any CODEOWNERS-derived owner. A `source = 'codeowners'` row is the
 * (currently unused on the write side) materialized form of a CODEOWNERS match;
 * v1 derives the CODEOWNERS leg on the fly from `projects.codeownersFile` in
 * `resolveTestOwners` rather than persisting it, so manual rows are the only
 * writers today. The column stays so a future "materialize CODEOWNERS at
 * ingest" pass is additive.
 *
 * Like `quarantinedTests`, every row carries denormalized `projectId` so tenant
 * isolation needs no join. `owner` is an OPAQUE label — a team handle
 * (`@team/web`) or an email — never resolved against `user`/`memberships`.
 */
export const testOwners = pgTable(
  "testOwners",
  {
    id: text("id").primaryKey(),
    projectId: text("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    testId: text("testId").notNull(),
    /** Opaque owner label, e.g. "@team/web" or "alice@example.com". */
    owner: text("owner").notNull(),
    /**
     * 'manual': an explicit owner-gated assignment (the source of truth that
     * overrides CODEOWNERS). 'codeowners': a materialized CODEOWNERS match
     * (reserved — v1 derives these on the fly, never inserts them).
     */
    source: text("source").$type<"manual" | "codeowners">().notNull(),
    createdAt: big("createdAt").notNull(),
  },
  (t) => [
    // One row per (project, test, owner) — assigning the same owner twice is an
    // upsert/ignore, not a duplicate.
    uniqueIndex("testOwners_project_testId_owner_idx").on(
      t.projectId,
      t.testId,
      t.owner,
    ),
    // Serves the per-test owner lookup (`projectId = ? AND testId IN (…)`) the
    // page-badge join (`resolveTestOwners`) runs.
    index("testOwners_project_testId_idx").on(t.projectId, t.testId),
  ],
);

// ---------- Audit log ----------

/**
 * Append-only team audit log (roadmap 3.2). One row per privileged mutation
 * (invite mint/revoke/accept, member remove/leave/role-change, key mint/revoke,
 * team rename/delete, project create/delete) written by `recordAudit`
 * (`src/lib/audit.ts`). Reverse-chron, owner-only viewer at
 * `/settings/teams/:teamSlug/audit`.
 *
 * **An audit row must OUTLIVE the entity it records.** A "project deleted" /
 * "team renamed" row has to survive the thing it describes, which dictates the
 * two FK onDelete choices below:
 *
 *  - `teamId` → teams `onDelete: "cascade"`. The audit log is *team*-scoped —
 *    when the team itself is deleted there is no longer anyone who could read
 *    its log (the viewer page is owner-only and the team's memberships cascade
 *    away too), so retaining orphaned audit rows for a dead team buys nothing.
 *    Cascade is therefore both acceptable AND the simplest choice. The
 *    `team.delete` row is still captured: `recordAudit` is awaited SYNCHRONOUSLY
 *    *before* the delete batch runs, so the actor/target context is persisted
 *    and (briefly) readable up to the moment the cascade removes the whole team.
 *
 *  - `projectId` → projects `onDelete: "set null"` (NULLABLE). A project delete
 *    must NOT cascade-delete the audit rows that record it — the "project
 *    deleted" entry is exactly the row a team owner wants to keep. So the FK
 *    nulls the column on project delete and the row persists under its team.
 *    The human-readable identity of the gone project (slug/name) is captured in
 *    `targetId` / `metadata` so the row stays meaningful after the project row
 *    is gone.
 *
 * `actorUserId` is the void-managed `user.id` of the actor — a LOGICAL FK (no
 * `.references()`), matching `memberships.userId` / `monitors.createdBy`.
 */
export const auditLog = pgTable(
  "auditLog",
  {
    id: text("id").primaryKey(),
    teamId: text("teamId")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    /**
     * Nullable + `set null` on project delete so a `project.delete` row
     * survives the project it records. See table doc-comment.
     */
    projectId: text("projectId").references(() => projects.id, {
      onDelete: "set null",
    }),
    /** void-managed `user.id` of the actor. Logical FK — see schema header. */
    actorUserId: text("actorUserId").notNull(),
    /**
     * Stable enum-ish action string (e.g. "invite.mint", "member.role_change",
     * "key.revoke", "team.delete", "project.create"). The canonical set lives in
     * `AUDIT_ACTIONS` (`src/lib/audit.ts`) so call sites don't stringly-drift.
     */
    action: text("action").notNull(),
    /** The kind of thing acted on ("invite" | "member" | "key" | "team" | "project"). */
    targetType: text("targetType"),
    /**
     * Human-readable identifier of the target (an email/login for invites, a key
     * label, a project slug, …) — captured here so the row stays meaningful even
     * after the underlying entity is deleted.
     */
    targetId: text("targetId"),
    /** Extra structured context as a JSON string (serialized by `recordAudit`). */
    metadata: text("metadata"),
    createdAt: big("createdAt").notNull(),
  },
  (t) => [
    // Serves the reverse-chron viewer page: WHERE teamId = ? ORDER BY createdAt
    // DESC — Postgres seeks the team partition and walks it newest-first.
    index("auditLog_team_createdAt_idx").on(t.teamId, t.createdAt),
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
export type UsageCounter = typeof usageCounters.$inferSelect;
export type GithubInstallation = typeof githubInstallations.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type TestResult = typeof testResults.$inferSelect;
export type TestTag = typeof testTags.$inferSelect;
export type TestAnnotation = typeof testAnnotations.$inferSelect;
export type TestResultAttempt = typeof testResultAttempts.$inferSelect;
export type Artifact = typeof artifacts.$inferSelect;
export type Monitor = typeof monitors.$inferSelect;
export type MonitorExecution = typeof monitorExecutions.$inferSelect;
export type QuarantinedTest = typeof quarantinedTests.$inferSelect;
export type TestOwner = typeof testOwners.$inferSelect;
export type AuditLogRow = typeof auditLog.$inferSelect;
