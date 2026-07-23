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
  check,
  index,
  integer,
  jsonb,
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
     * enforces. When billing is ON (`billingEnabled()`): `'free'` (default) →
     * the `WRIGHTFUL_FREE_*` ceilings, `'pro'` (incl. the 14-day app-managed
     * trial) → the higher, configurable, FINITE `WRIGHTFUL_PRO_*` ceilings.
     * When billing is OFF (the OSS / self-host default) every tier is UNLIMITED
     * — see the `tierLimits` short-circuit. The Polar billing mirror below is
     * the source for paid/trial gating; this column is the enforcement seam.
     */
    tier: text("tier").notNull().default("free"),
    // ---- Polar billing mirror (Polar is source of truth; this is a read-cache for synchronous gating). ----
    polarCustomerId: text("polarCustomerId"), // null = trial-pro or free; non-null = paid
    polarSubscriptionId: text("polarSubscriptionId"),
    subscriptionStatus: text("subscriptionStatus"), // 'active' | 'canceled' | 'revoked' | ...
    currentPeriodEnd: big("currentPeriodEnd"), // epoch-seconds: paid-through / trial-end (D3/D9)
    billingUpdatedAt: big("billingUpdatedAt"), // epoch-seconds: ordering guard — apply-if-newer (D9)
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
    // The artifact window must stay ≤ the testResults window so an expiring
    // testResult's FK cascade never orphans still-live R2 objects. This was
    // enforced ONLY in the settings action (`general.server.ts`); the CHECK
    // closes the gap for seed scripts / admin tools / billing-sync writes. It
    // covers only the both-set case (a DB CHECK can't see the `WRIGHTFUL_RETENTION_*`
    // env defaults a NULL falls back to), so the settings-action validation of
    // the mixed NULL/env cases stays load-bearing. See schema-rework-plan Phase 3.
    check(
      "teams_retention_window_chk",
      sql`${t.retentionArtifactDays} is null or ${t.retentionTestResultsDays} is null or ${t.retentionArtifactDays} <= ${t.retentionTestResultsDays}`,
    ),
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
// These FK children are intentionally unindexed: navigation updates them often,
// while parent deletion is rare and userState has only one row per user.
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
 * (`usageBumpStatement` in `src/lib/usage.ts`) — a run open bumps `runsCount`,
 * an artifact registration bumps `artifactBytes`/`artifactCount` — atomically
 * with the data it meters, never a separate round-trip. testResults are NOT
 * metered here at all (there is deliberately no `testResultsCount` column — it
 * would have serialized every concurrent /results flush of a team on this single
 * row, and testResults is never quota-gated): the count is derived on read
 * (`countTeamTestResults`) wherever it's shown. `periodStart` is the UTC month-boundary epoch-seconds
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
    // NB: `testResultsCount` was removed (schema-rework-plan Phase 3). It was a
    // half-alive column — never bumped on the /results hot path (that upsert
    // serialized every concurrent flush of a team on this one row), never read by
    // the usage page (which derives it via `countTeamTestResults`), only re-based
    // by the rollup cron. The derived-on-read path is the single source now.
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

/** One App-posted sticky comment per project, repository, and pull request. */
export const githubPrComments = pgTable(
  "githubPrComments",
  {
    id: text("id").primaryKey(),
    projectId: text("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    repo: text("repo").notNull(),
    prNumber: integer("prNumber").notNull(),
    commentId: big("commentId"),
    runId: text("runId").references(() => runs.id, { onDelete: "set null" }),
    claimedAt: big("claimedAt"),
    createdAt: big("createdAt").notNull(),
    updatedAt: big("updatedAt").notNull(),
  },
  (t) => [
    uniqueIndex("githubPrComments_project_repo_pr_idx").on(
      t.projectId,
      t.repo,
      t.prNumber,
    ),
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
     *   2. Single-hop authz on the realtime socket: the run-room subscription
     *      gate (`authorizeTopicSubscription` in `src/lib/authz.ts`, wired into
     *      `routes/ws/run/[runId].ws.ts`) resolves a subscriber's read access by
     *      `SELECT teamId FROM runs WHERE id = ?` then joining memberships,
     *      instead of hopping through projects.
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
    /**
     * Reporter-declared suite size from `onBegin` — the exact denominator for
     * "how far through the suite is this run". Null only on rows that predate
     * the column. For a sharded run this is the SUM over
     * {@link runs.shardExpectedTests}, re-derived on every shard's open.
     */
    expectedTotalTests: integer("expectedTotalTests"),
    /**
     * Per-shard planned-test counts for a sharded run: a jsonb map of
     * 1-based shard index → that shard's `onBegin` `suite.allTests()` size,
     * e.g. `{"1": 100, "2": 120}`. Playwright filters the suite before
     * reporters see it, so no single shard knows the full suite size — the
     * exact total only exists as the sum of these slices. `openRun` merges
     * each shard's count in via `jsonb_set` (keyed by shard index, so a
     * reporter retry / CI re-run REPLACES a shard's count instead of
     * double-counting) and re-derives `expectedTotalTests` as the sum in the
     * same UPDATE. Kept on the run row (not a child table) deliberately: the
     * retention cron that tidies old runs never has to know about it. Null for
     * non-sharded runs, whose open count lands directly on
     * `expectedTotalTests`.
     */
    shardExpectedTests:
      jsonb("shardExpectedTests").$type<Record<string, number>>(),
    /**
     * Total number of Playwright shards contributing to this run, from
     * `config.shard.total` on the open payload. NULL for a non-sharded run (or
     * a pre-shard-aware reporter) — the completeRun path treats NULL / ≤1 as
     * "finalize on the single /complete" (the legacy behavior).
     *
     * When >1 it is the load-bearing denominator for deferred finalization:
     * `completeRun` keeps the run at status='running' until `runShards` holds a
     * terminal row for every shard, so the run no longer flips to a terminal
     * status the instant the FIRST shard finishes while siblings still stream.
     * See `completeRun` in `src/lib/ingest.ts`.
     */
    expectedShards: integer("expectedShards"),
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
     * 'interrupted'. NOT NULL — every writer sets it (initialized to `createdAt`
     * at open, bumped in-transaction on every subsequent write), so
     * `staleRunFilter` reads it directly with no `coalesce` fallback. (Rows that
     * predated the column were backfilled to `createdAt` when it was tightened —
     * see `docs/schema-rework-plan.md` Phase 4.)
     */
    lastActivityAt: big("lastActivityAt").notNull(),
    completedAt: big("completedAt"),
    /**
     * Where this run came from. `'ci'` (default) — a normal reporter run from
     * CI/local. `'synthetic'` — produced by a scheduled synthetic monitor (see
     * `monitors`). Lets the runs list / insights include or separate synthetic
     * traffic. Existing rows default to `'ci'`.
     */
    origin: text("origin").notNull().default("ci"),
    /**
     * For `origin = 'synthetic'`, the `monitors.id` this run belongs to. Null
     * for CI runs. A REAL FK with `onDelete: "set null"`: there is no cycle to
     * avoid (`monitors` references only `teams`/`projects`, never `runs`), and
     * `set null` is exactly the intended semantics — a deleted monitor leaves the
     * run retained with a null link, which readers already treat gracefully.
     * (Was a logical FK on a since-disproven cycle rationale — see
     * `docs/schema-rework-plan.md` Phase 3.)
     */
    monitorId: text("monitorId").references(() => monitors.id, {
      onDelete: "set null",
    }),
    /**
     * The GitHub check-run id created for this run, or null. Lets the terminal
     * path (`completeRun` / `finalizeStaleRun` → `postGithubRunSurfaces`) PATCH
     * the existing check on a re-complete instead of POSTing a duplicate.
     * Always a real check-run id, or null — never a sentinel.
     */
    githubCheckRunId: big("githubCheckRunId"),
    /**
     * Epoch-seconds when a caller claimed the right to POST this run's check run,
     * or null. Makes concurrent `completeRun` + `finalizeStaleRun` race-safe: only
     * one caller's claim `UPDATE ... WHERE` matches (`claimCheckRunSlot` in
     * `@/lib/github-checks`), so only one POSTs while the loser backs off. A claim
     * older than `CHECK_CLAIM_TTL_SECONDS` (same file) is stale/reclaimable — its
     * poster crashed before finishing. Cleared once the real id lands in
     * `githubCheckRunId`, or if the POST fails.
     */
    githubCheckClaimedAt: big("githubCheckClaimedAt"),
  },
  (t) => [
    uniqueIndex("runs_project_idempotency_key_idx").on(
      t.projectId,
      t.idempotencyKey,
    ),
    // (Dropped `runs_project_monitor_created_at_idx` — it was self-documented
    // "pure write amplification" for a "runs for this monitor" list that never
    // landed. Re-add it WITH that feature; index additions are cheap + additive.
    // See schema-rework-plan Phase 3.)
    //
    // Indexes the child side of the `runs.monitorId → monitors` FK so its
    // `onDelete: "set null"` doesn't seq-scan the (largest) runs table on every
    // monitor deletion. PARTIAL (`WHERE monitorId IS NOT NULL`) so it stays tiny:
    // only synthetic runs carry a monitorId — the CI hot path is null and not
    // indexed, adding no write amplification there.
    index("runs_monitorId_idx")
      .on(t.monitorId)
      .where(sql`${t.monitorId} is not null`),
    index("runs_project_created_at_idx").on(t.projectId, t.createdAt),
    /**
     * Serves the usage reconcile's team-scoped period counts (`rollup-usage` cron:
     * `teams ⟕ runs ON teamId AND createdAt >= periodStart GROUP BY team`). Every
     * other runs index leads with `projectId`, so without this the team-keyed count
     * seq-scans the largest table.
     */
    index("runs_team_createdAt_idx").on(t.teamId, t.createdAt),
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
    /**
     * Trigram GINs backing the runs-list free-text `q` search
     * (`runs-filters-where.ts`): a leading-wildcard `ILIKE '%q%'` OR'd across
     * commitMessage/commitSha/branch that no b-tree can accelerate. Same pattern as
     * the `tests` catalog's title/file GINs (same `pg_trgm` extension, created by
     * migration `20260703092642_slimy_layla_miller.sql`). Write amplification lands
     * on run open only (one row per run), so the /results ingest hot path is unaffected.
     */
    index("runs_commitMessage_trgm_idx").using(
      "gin",
      t.commitMessage.op("gin_trgm_ops"),
    ),
    index("runs_commitSha_trgm_idx").using(
      "gin",
      t.commitSha.op("gin_trgm_ops"),
    ),
    index("runs_branch_trgm_idx").using("gin", t.branch.op("gin_trgm_ops")),
  ],
);

/**
 * Per-shard completion record for a sharded run. A sharded Playwright suite
 * shares ONE `runs` row (all shards derive the same idempotencyKey); this table
 * holds one row per shard so the run can (1) defer its terminal status until
 * every shard has reported and (2) surface a per-shard status breakdown in the
 * UI. Written by `completeRun` — one row per shard, upserted on the
 * `(projectId, runId, shardIndex)` unique so a reporter retry of `/complete` is
 * idempotent. A shard with no row yet is one that has not finished; the run
 * stays `running` until `count(rows) >= runs.expectedShards`.
 *
 * Tenant-scoped like the other run children: carries `projectId` so every read
 * filters by scope without joining through `runs`.
 */
export const runShards = pgTable(
  "runShards",
  {
    id: text("id").primaryKey(),
    projectId: text("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    runId: text("runId")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    /** Playwright `config.shard.current` — 1-based shard index. */
    shardIndex: integer("shardIndex").notNull(),
    /** Playwright `config.shard.total` — denormalized copy of the run's expectedShards. */
    shardTotal: integer("shardTotal").notNull(),
    /** This shard's own terminal status ('passed' | 'failed' | 'timedout' | 'interrupted'). */
    status: text("status").notNull(),
    durationMs: integer("durationMs").notNull(),
    completedAt: big("completedAt").notNull(),
    createdAt: big("createdAt").notNull(),
  },
  (t) => [
    // One terminal row per shard; the reporter's `/complete` retry upserts onto
    // this so a re-sent completion never double-counts toward expectedShards.
    // (projectId, runId) is a prefix so the "shards for this run" read seeks.
    uniqueIndex("runShards_project_run_shard_idx").on(
      t.projectId,
      t.runId,
      t.shardIndex,
    ),
    /** Supports the `runShards.runId → runs` cascade. */
    index("runShards_runId_idx").on(t.runId),
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
    /** Playwright shard that ran this test (config.shard.current, 1-based); null for a non-sharded run. */
    shardIndex: integer("shardIndex"),
    /**
     * INSERT-ONLY first-seen time. Set once — at the queued prefill (run open)
     * for a planned test, or at the first streamed result for a non-prefilled
     * one — and NEVER rewritten by a later /results flush. That is what keeps it
     * a true insert timestamp (not "last-modified"), so usage metering by month,
     * analytics time-buckets, retention age, and the createdAt cursor all read a
     * stable value. The mutable "last write" time lives in {@link updatedAt}.
     */
    createdAt: big("createdAt").notNull(),
    /**
     * Last-write time — bumped to the flush time on every /results upsert of this
     * (runId, testId) row (and set = createdAt on first insert). NOT NULL — both
     * write paths (prefill insert + /results upsert) always set it, so a reader
     * that wants a last-modified value reads it directly with no `coalesce`. No
     * reader needs it yet, so it carries no index. Splitting write-time out of
     * `createdAt` is the fix for the old UPDATE path that rewrote `createdAt` to
     * the flush time. (Rows predating the column were backfilled to `createdAt`
     * when it was tightened — see `docs/schema-rework-plan.md` Phase 4.)
     */
    updatedAt: big("updatedAt").notNull(),
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
    // NB: the ⌘K test-search trigram GIN indexes used to live here, over the
    // ENTIRE retained result history. They moved to the `tests` catalog table
    // below (bounded by suite size, not history) — see `docs/schema-rework-plan.md`
    // Phase 1. The `pg_trgm` extension stays (created by migration
    // `20260703092642_slimy_layla_miller.sql`) because `tests` now needs it.
  ],
);

/**
 * Per-project test identity catalog — one row per stable `testId`, the dimension
 * table `testResults` (a fact table, one row per test PER RUN) never had.
 *
 * Upserted at ingest inside the same `runBatch` as the results it describes
 * (openRun's queued-test prefill AND appendRunResults), latest-wins on
 * `title`/`file` — see `buildTestCatalogUpsertStatements` in `src/lib/ingest.ts`.
 *
 * It exists to stop three consumers from each re-deriving test identity off the
 * fact table:
 *   1. The ⌘K command-palette search (`ILIKE '%q%'` on title/file) reads THIS
 *      table, so the trigram GIN indexes are bounded by suite size instead of
 *      retained-row count (the reason they moved off `testResults`).
 *   2. The tests-catalog + slowest-tests `q` filter resolves matching `testId`s
 *      here (`searchFragment`) instead of scanning the result partition.
 *   3. Quarantine / ownership key on the bare `(projectId, testId)` — this is
 *      their natural anchor row (a hard composite FK is deferred, see the plan).
 *
 * Identity/dimension only: NO status or aggregate columns — those stay derived
 * from `testResults` on read. Carries denormalized `projectId` like every other
 * run-scoped table so tenant isolation needs no join. NOT swept by the retention
 * cron (bounded by suite size, not history).
 */
export const tests = pgTable(
  "tests",
  {
    id: text("id").primaryKey(),
    projectId: text("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** Stable Playwright test id — the same value `testResults`/quarantine/owners key on. */
    testId: text("testId").notNull(),
    /** Latest-seen title; refreshed on every ingest upsert of this (projectId, testId). */
    title: text("title").notNull(),
    /** Latest-seen spec file; refreshed on every ingest upsert. */
    file: text("file").notNull(),
    /** INSERT-ONLY first-seen time — kept on conflict, never rewritten. */
    firstSeenAt: big("firstSeenAt").notNull(),
    /** Bumped to the ingest time on every upsert of this (projectId, testId). */
    lastSeenAt: big("lastSeenAt").notNull(),
  },
  (t) => [
    // The upsert conflict target AND the point-seek for quarantine/owner anchoring.
    uniqueIndex("tests_project_testId_idx").on(t.projectId, t.testId),
    // Backs the palette's recent-first ordering and the catalog's default sort.
    index("tests_project_lastSeenAt_idx").on(t.projectId, t.lastSeenAt),
    // Trigram GIN backing the ⌘K palette + catalog `q` search — matches
    // title/file with a LEADING-wildcard `ILIKE '%q%'` a b-tree can't accelerate.
    // Over `tests` these are bounded by the project's live suite size, not its
    // full retained result history. REQUIRES the `pg_trgm` extension (already
    // created by an earlier migration; the generated migration needs no augment).
    index("tests_title_trgm_idx").using("gin", t.title.op("gin_trgm_ops")),
    index("tests_file_trgm_idx").using("gin", t.file.op("gin_trgm_ops")),
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
    // Captured per-attempt stdout/stderr (the reporter joins Playwright's
    // TestResult chunks, each truncated to MAX.MESSAGE = 65536 chars). Stored
    // inline — attempts per test are few (1–10) and capped — so `get_test_result`
    // can surface `console.log` CI output. Nullable, NOT indexed (never filtered
    // or joined on; read only as part of the per-attempt row).
    stdout: text("stdout"),
    stderr: text("stderr"),
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
    // bigint, not integer: the cap is env-configurable via
    // `WRIGHTFUL_MAX_ARTIFACT_BYTES` (default 50 MiB), and an operator setting a
    // >2 GiB cap would overflow int4. `usage.ts`'s `coalesce(sum(...))` already
    // routes through `numericSql`, so the read side is unaffected.
    sizeBytes: big("sizeBytes").notNull(),
    /**
     * R2 object key. Built by `buildArtifactR2Key` in `src/lib/artifacts/store.ts`:
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
     * mirror of `artifactIdentity()` in `src/lib/artifacts/store.ts` — keep the two
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
     * Who alerts notify, as `jsonb`. `null` = ALL team members (the default). A
     * `{ users: string[], groups: string[] }` object = those specific members +
     * the members of those `memberGroups`, unioned and re-intersected with live
     * memberships at send time. Parsing/expansion: `src/lib/monitors/alert-targets.ts`.
     */
    alertTargets: jsonb("alertTargets").$type<{
      users: string[];
      groups: string[];
    }>(),
    /** Playwright spec source for `type = 'browser'`; null for non-browser types. */
    source: text("source"),
    /**
     * Type-specific config as `jsonb` (e.g. browser: timeout/workers; http:
     * url/assertions; tcp: host/port). Polymorphic by monitor `type`, so it
     * carries no `$type` here — the read path validates + narrows it through the
     * Zod parsers in `monitor-schemas.ts` (`parseHttpMonitorConfig` / `parseTcpMonitorConfig`).
     */
    config: jsonb("config"),
    intervalSeconds: integer("intervalSeconds").notNull(),
    /** 'round_robin' | 'parallel' — reserved for multi-location; v1 single origin. */
    schedulingStrategy: text("schedulingStrategy")
      .notNull()
      .default("round_robin"),
    /** Retries/anti-flapping config as `jsonb`. Reserved (not consumed in v1). */
    retryConfig: jsonb("retryConfig"),
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
 * later). `runId` is a real FK to `runs.id` with `onDelete: "set null"` — a
 * deleted run leaves the execution row intact with a null link (there is no FK
 * cycle to avoid; see schema-rework-plan Phase 3).
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
    /**
     * `runs.id` for browser executions; null otherwise. REAL FK with
     * `onDelete: "set null"` (no cycle exists — see the same fix on
     * `runs.monitorId`): a deleted run leaves the execution row intact with a
     * null link, the behavior the old logical-FK comment described wanting.
     */
    runId: text("runId").references(() => runs.id, { onDelete: "set null" }),
    durationMs: integer("durationMs"),
    /**
     * HTTP response status code for `http` (uptime) executions; null for browser
     * and for `http` checks that never got a response (network error / timeout).
     * Stored as a queryable column (vs buried in `resultDetail`) so the list /
     * timeline can show + filter by it without parsing JSON.
     */
    statusCode: integer("statusCode"),
    /**
     * Inline result detail for `http`/`tcp` executions as `jsonb`
     * (`HttpResultDetail` / `TcpResultDetail`): per-assertion outcomes, timing
     * phases, redirect chain, and a capped body excerpt on a failed body
     * assertion. Null for browser executions (whose detail lives in the linked
     * `runs` row). Polymorphic by execution type, so no `$type` — the read path
     * validates + narrows it via `parseHttpResultDetail` / `parseTcpResultDetail`.
     */
    resultDetail: jsonb("resultDetail"),
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
    /** Supports `runId` nulling while excluding executions without a run. */
    index("monitorExecutions_runId_idx")
      .on(t.runId)
      .where(sql`${t.runId} is not null`),
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
    // upsert/ignore, not a duplicate. Its leading `(projectId, testId)` prefix
    // also serves the per-test owner lookup (`projectId = ? AND testId IN (…)`)
    // the page-badge join (`resolveTestOwners`) runs, so no standalone
    // `(projectId, testId)` index is needed.
    uniqueIndex("testOwners_project_testId_owner_idx").on(
      t.projectId,
      t.testId,
      t.owner,
    ),
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
    /** Extra structured context as `jsonb` (written directly by `recordAudit`). */
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
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
export type TestCatalogRow = typeof tests.$inferSelect;
export type TestTag = typeof testTags.$inferSelect;
export type TestAnnotation = typeof testAnnotations.$inferSelect;
export type TestResultAttempt = typeof testResultAttempts.$inferSelect;
export type Artifact = typeof artifacts.$inferSelect;
export type Monitor = typeof monitors.$inferSelect;
export type MonitorExecution = typeof monitorExecutions.$inferSelect;
export type QuarantinedTest = typeof quarantinedTests.$inferSelect;
export type TestOwner = typeof testOwners.$inferSelect;
export type AuditLogRow = typeof auditLog.$inferSelect;
