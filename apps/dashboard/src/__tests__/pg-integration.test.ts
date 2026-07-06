// @vitest-environment node
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import type { Order } from "@polar-sh/sdk/models/components/order";
import type { Subscription } from "@polar-sh/sdk/models/components/subscription";
import type { TestResultInput } from "@/lib/schemas";

/**
 * The database integration test — proves the data layer actually EXECUTES on
 * Postgres, not just that it typechecks. It runs the real `db/schema` + the data
 * seam (`runBatch`, `bucketExpr`, `isUniqueViolation`, `numericSql`,
 * `cast(… as integer)`) against Postgres: by default the in-process pglite (WASM,
 * no Docker) for fast local runs, and against a REAL node-postgres when
 * `PG_TEST_URL` is set (the CI authority — pglite can't reproduce node-postgres
 * result shapes like int8-as-string). Exercises the Postgres semantics a stub-
 * mocked unit test can't: transaction atomicity, `to_char` month bucketing,
 * SQLSTATE `23505`, and the int8→number coercions.
 */

// Build the backing Drizzle instance BEFORE any import of the modules under test
// resolves `void/db` (vi.hoisted runs first).
const h = await vi.hoisted(async () => {
  const schema = await import("../../db/schema");

  // Two variants of the SAME suite (Kysely's pattern), so a divergence the
  // surrogate hides shows up as a CI diff:
  //   - PG_TEST_URL set  → REAL Postgres via node-postgres (the production
  //     driver). This is the authority — it reproduces node-postgres result
  //     shapes pglite cannot, e.g. int8/numeric returned as STRINGS (the bug
  //     class behind `numericSql`/`cast(… as integer)`; see
  //     project_pg_pglite_int8_string_trap). Run in CI against a `services:`
  //     Postgres. `max: 1` so the TZ test's `SET TIME ZONE` persists across
  //     queries (a multi-connection pool would scatter them).
  //   - unset → in-process pglite (WASM Postgres) — the fast, no-infra default
  //     for local dev runs.
  const url = process.env.PG_TEST_URL;
  if (url) {
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { sql } = await import("void/_db");
    const db = drizzle({
      connection: { connectionString: url, max: 1 },
      schema,
    });
    return {
      driver: "node-postgres" as const,
      db,
      client: {
        exec: (s: string) => db.execute(sql.raw(s)),
        close: () => db.$client.end(),
      },
    };
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  const db = drizzle(client, { schema });
  return {
    driver: "pglite" as const,
    db,
    client: {
      exec: (s: string) => client.exec(s),
      close: () => client.close(),
    },
  };
});

// `void/db` → the pglite instance, with the REAL Drizzle operators (incl. `sql`)
// from the non-intercepted `void/_db` entry.
vi.mock("void/db", async () => {
  const ops = await vi.importActual<Record<string, unknown>>("void/_db");
  return { ...ops, db: h.db };
});

// The billing tests below need `void/env` (the node lane aliases it to an EMPTY
// stub, so the gating functions would otherwise see no caps + billing-off) and
// `@polar-sh/sdk` (the reconcile network boundary). Both back onto hoisted
// mutables so each test drives billing-on/off + the synthetic Polar
// `subscriptions.list` page. The existing DB-seam tests above read no env, so the
// empty default leaves them unaffected.
const { billingConfig, polarStub } = vi.hoisted(() => ({
  billingConfig: {} as Record<string, unknown>,
  polarStub: { items: [] as unknown[] },
}));
vi.mock("void/env", () => ({ env: billingConfig }));
vi.mock("@polar-sh/sdk", () => ({
  Polar: class {
    subscriptions = {
      // `subscriptions.list` returns a PageIterator — an async-iterable of pages
      // (fact 10) — so reconcile consumes it with `for await`.
      list: () =>
        Promise.resolve({
          async *[Symbol.asyncIterator]() {
            yield { result: { items: polarStub.items } };
          },
        }),
    };
  },
}));

const { changedRows, runBatch, isUniqueViolation } =
  await import("@/lib/db-batch");
const { runRows } = await import("@/lib/db-run");
const { bucketExpr } = await import("@/lib/analytics/bucketing-sql");
const { numericSql } = await import("@/lib/db/sql-ops");
const {
  chunkByParams,
  mergeRunStatus,
  mergeRunStatusSql,
  resolveTestResultIds,
  buildResultInsertStatements,
  buildTestCatalogUpsertStatements,
  computeAggregateDelta,
} = await import("@/lib/ingest");
const { makeTenantScope } = await import("@/lib/scope");
const { loadRunGroupSkeleton } = await import("@/lib/run-groups-page");
const { loadRunResultsPage } = await import("@/lib/run-results-page");
const { assertUserDeletable, cleanupUserData, findSoleOwnerTeamIds } =
  await import("@/lib/user-teardown");
const { httpResponseTimeBuckets, httpUptimeWindows } =
  await import("@/lib/monitors/http/uptime-analytics");
const {
  auditLog,
  memberGroupMembers,
  memberships,
  monitorExecutions,
  monitors,
  projects,
  runs,
  teams,
  testAnnotations,
  testResultAttempts,
  testResults,
  tests,
  testTags,
  usageCounters,
  userGithubAccounts,
  userState,
} = await import("../../db/schema");
const { updateMonitor } = await import("@/lib/monitors/monitors-repo");
const { parseHttpMonitorConfig, HttpMonitorConfigSchema } =
  await import("@/lib/monitors/monitor-schemas");
const { buildTestSearchWhere } = await import("@/lib/command-search");
const { and, count, desc, eq, sql } = await import("void/_db");
const { getTableConfig } = await import("void/schema-pg");

// Billing modules under test (imported via `await import` so the void/db +
// void/env + @polar-sh/sdk mocks apply).
const { checkQuota, countTeamTestResults, monthStartSeconds } =
  await import("@/lib/usage");
const { effectiveTier, BILLING_PERIOD_GRACE_SECONDS } =
  await import("@/lib/billing/tier");
const { loadTeamBilling } = await import("@/lib/billing/subscription");
const { reconcileBilling } = await import("@/lib/billing/reconcile");
const {
  onSubscriptionActive,
  onSubscriptionCanceled,
  onSubscriptionRevoked,
  onOrderPaid,
} = await import("@/lib/billing/polar-webhook");

/** Map a Drizzle pg column type to its CREATE TABLE SQL type. */
function pgType(columnType: string): string {
  if (columnType.includes("BigInt")) return "bigint";
  if (columnType.includes("Integer")) return "integer";
  if (columnType.includes("Jsonb")) return "jsonb";
  return "text";
}

/**
 * Derive `CREATE TABLE` DDL straight from the `schema.pg` table config — so the
 * test DDL can't drift from the schema (no hand-written column list). Columns +
 * single-column PKs only; FKs and indexes are omitted (not needed to exercise
 * the seam, and skipping FKs sidesteps insertion-order constraints).
 */
function createTableSql(table: Parameters<typeof getTableConfig>[0]): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const parts = [`"${c.name}"`, pgType(c.columnType)];
    if (c.primary) parts.push("primary key");
    if (c.notNull && !c.primary) parts.push("not null");
    return parts.join(" ");
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

beforeAll(async () => {
  for (const t of [
    teams,
    projects,
    runs,
    testResults,
    usageCounters,
    monitorExecutions,
  ]) {
    // Drop-then-create so the suite is re-runnable against a PERSISTENT
    // Postgres (a `services:` container is fresh, but a locally-reused one
    // would already hold the tables). Harmless on the fresh pglite instance.
    const { name } = getTableConfig(t);
    await h.client.exec(`drop table if exists "${name}" cascade;`);
    await h.client.exec(createTableSql(t));
  }
});

afterAll(async () => {
  await h.client.close();
});

describe("Postgres path", () => {
  it("runBatch commits a multi-statement transaction atomically", async () => {
    await runBatch((tx) => [
      tx.insert(teams).values({
        id: "t1",
        slug: "acme",
        name: "Acme",
        tier: "free",
        createdAt: 1_700_000_000,
      }),
      tx.insert(usageCounters).values({
        id: "u1",
        teamId: "t1",
        periodStart: 1_700_000_000,
        runsCount: 3,
        artifactBytes: 9_000_000_000, // > int4 max — proves bigint
        artifactCount: 0,
        updatedAt: 1_700_000_000,
      }),
    ]);

    const teamRows = await h.db.select().from(teams).where(eq(teams.id, "t1"));
    expect(teamRows).toHaveLength(1);
    const usage = await h.db
      .select()
      .from(usageCounters)
      .where(eq(usageCounters.id, "u1"));
    expect(usage[0]?.artifactBytes).toBe(9_000_000_000);
  });

  it("runBatch rolls the whole batch back when a statement fails (atomicity)", async () => {
    await expect(
      runBatch((tx) => [
        tx.insert(teams).values({
          id: "t2",
          slug: "rollback-me",
          name: "Rollback",
          tier: "free",
          createdAt: 1_700_000_100,
        }),
        // Duplicate PK — violates the primary key, aborting the transaction.
        tx.insert(teams).values({
          id: "t1",
          slug: "dupe",
          name: "Dupe",
          tier: "free",
          createdAt: 1_700_000_100,
        }),
      ]),
    ).rejects.toThrow();

    // The first insert must NOT have persisted — the transaction rolled back.
    const rolled = await h.db.select().from(teams).where(eq(teams.id, "t2"));
    expect(rolled).toHaveLength(0);
  });

  it("chunkByParams packs flushes into few statements under the 65535 ceiling", () => {
    // Each statement in a transaction is its own round-trip, so the 65535
    // ceiling keeps a big flush from becoming hundreds of round-trips: a
    // 14-column insert packs ~4681 rows/statement.
    const rows = Array.from({ length: 5000 }, (_, i) => i);
    expect(chunkByParams(rows, 14)[0]).toHaveLength(Math.floor(65535 / 14));
    expect(chunkByParams(rows, 14).length).toBeLessThan(3);
  });

  it("changedRows reads the affected-row count from a no-returning update", async () => {
    // The Postgres result shape (`affectedRows` on pglite, `rowCount` on
    // node-postgres) differs from D1's `meta.changes`; `changedRows` must read
    // it so the guarded-write callers (reconcileAndBroadcast's no-op finalize,
    // the invite-decline 404 probe) work on PG. runBatch returns the collected
    // per-statement results, so res[0] is the update's driver result.
    const [hit] = await runBatch((tx) => [
      tx.update(teams).set({ name: "renamed" }).where(eq(teams.id, "t1")),
    ]);
    expect(changedRows(hit)).toBe(1);

    const [miss] = await runBatch((tx) => [
      tx
        .update(teams)
        .set({ name: "nope" })
        .where(eq(teams.id, "does-not-exist")),
    ]);
    expect(changedRows(miss)).toBe(0);
  });

  it("isUniqueViolation recognizes a Postgres 23505 error", async () => {
    let caught: unknown;
    try {
      await h.db.insert(teams).values({
        id: "t1", // duplicate PK
        slug: "again",
        name: "Again",
        tier: "free",
        createdAt: 1_700_000_200,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(isUniqueViolation(caught)).toBe(true);
  });

  it("mergeRunStatusSql executes to the SAME terminal status as mergeRunStatus (full matrix)", async () => {
    // The structural workers test (`merge-run-status.workers.test.ts`) pins the
    // SQL CASE's token shape from the captured stub; this EXECUTES the UPDATE on
    // real Postgres so it also proves the comparator DIRECTION (the SQL compares
    // `current < incoming`, so `incoming` wins iff STRICTLY more severe) and the
    // running-bypass match the JS reference over the whole status cross-product —
    // the sharding invariant that a later all-passing shard can't overwrite an
    // earlier failure. Runs on pglite by default, real node-postgres under
    // PG_TEST_URL. (FKs are omitted from the test DDL, so arbitrary team/project
    // ids are fine; `origin` is supplied because the test DDL drops the default.)
    const RID = "run_merge_matrix";
    await h.db.insert(runs).values({
      id: RID,
      teamId: "t1",
      projectId: "p1",
      totalTests: 0,
      passed: 0,
      failed: 0,
      flaky: 0,
      skipped: 0,
      durationMs: 0,
      status: "running",
      createdAt: 1_700_000_000,
      lastActivityAt: 1_700_000_000,
      origin: "ci",
    });

    // running/queued are pre-terminal; the rest span every severity rank
    // (including the failed/timedout tie at rank 4) plus an unknown status.
    const STATUSES = [
      "running",
      "queued",
      "passed",
      "skipped",
      "flaky",
      "interrupted",
      "timedout",
      "failed",
      "weird-unknown",
    ];

    try {
      for (const current of STATUSES) {
        for (const incoming of STATUSES) {
          await h.db
            .update(runs)
            .set({ status: current })
            .where(eq(runs.id, RID));
          await h.db
            .update(runs)
            .set({ status: mergeRunStatusSql(incoming) })
            .where(eq(runs.id, RID));
          const [row] = await h.db
            .select({ status: runs.status })
            .from(runs)
            .where(eq(runs.id, RID));
          // Label the assertion with the pair so a divergence names the case.
          expect(`${current} + ${incoming} => ${row?.status}`).toBe(
            `${current} + ${incoming} => ${mergeRunStatus(current, incoming)}`,
          );
        }
      }
    } finally {
      // This suite shares one `runs` table across tests (a later month-bucketing
      // test counts rows), so remove the seeded row instead of leaking it.
      await h.db.delete(runs).where(eq(runs.id, RID));
    }
  });

  it("countTeamTestResults counts in-period testResults, scoped by project + window", async () => {
    // The usage page's testResults number is now derived live by this helper
    // (the hot-path counter was removed), and `reconcileUsage` uses the same
    // helper — so this pins the scoping both rely on: only the team's OWN
    // projects, only rows whose createdAt is within the period.
    const PERIOD = monthStartSeconds(1_700_000_000); // 2023-11-01 UTC
    await h.db.insert(projects).values([
      {
        id: "p_cnt",
        teamId: "t_cnt",
        slug: "cnt",
        name: "Cnt",
        createdAt: PERIOD,
      },
      {
        id: "p_cnt2",
        teamId: "t_cnt",
        slug: "cnt2",
        name: "Cnt2",
        createdAt: PERIOD,
      },
      {
        id: "p_oth",
        teamId: "t_oth",
        slug: "oth",
        name: "Oth",
        createdAt: PERIOD,
      },
    ]);
    const tr = (id: string, projectId: string, createdAt: number) => ({
      id,
      projectId,
      runId: "r_cnt",
      testId: id,
      title: "t",
      file: "f",
      status: "passed",
      durationMs: 0,
      retryCount: 0,
      createdAt,
      updatedAt: createdAt,
    });
    await h.db.insert(testResults).values([
      tr("c1", "p_cnt", PERIOD + 10), // in-period, team's project
      tr("c2", "p_cnt", PERIOD + 20), // in-period, team's project
      tr("c3", "p_cnt2", PERIOD + 30), // in-period, team's OTHER project
      tr("c_old", "p_cnt", PERIOD - 100), // before period → excluded
      tr("c_oth", "p_oth", PERIOD + 10), // another team's project → excluded
    ]);
    try {
      expect(await countTeamTestResults("t_cnt", PERIOD)).toBe(3);
      expect(await countTeamTestResults("t_oth", PERIOD)).toBe(1);
      // A team with no projects/rows reads zero (not null/NaN).
      expect(await countTeamTestResults("t_none", PERIOD)).toBe(0);
    } finally {
      await h.db.delete(testResults);
      await h.db.delete(projects).where(eq(projects.teamId, "t_cnt"));
      await h.db.delete(projects).where(eq(projects.teamId, "t_oth"));
    }
  });

  it("bucketExpr('month') emits valid Postgres date SQL and groups correctly", async () => {
    // Two runs in 2023-11 (epoch 1_700_000_000 ≈ 2023-11-14) and one in 2023-12.
    const nov = 1_700_000_000;
    const dec = 1_701_500_000; // ≈ 2023-12-02
    await runBatch((tx) =>
      [
        { id: "r1", createdAt: nov },
        { id: "r2", createdAt: nov + 60 },
        { id: "r3", createdAt: dec },
      ].map((r) =>
        tx.insert(runs).values({
          id: r.id,
          teamId: "t1",
          projectId: "p-unused",
          totalTests: 1,
          passed: 1,
          failed: 0,
          flaky: 0,
          skipped: 0,
          durationMs: 10,
          status: "passed",
          origin: "ci",
          createdAt: r.createdAt,
          lastActivityAt: r.createdAt,
        }),
      ),
    );

    const month = bucketExpr("month");
    const rows = await h.db
      .select({ bucket: month, n: count() })
      .from(runs)
      .groupBy(month)
      .orderBy(month);

    // Real Postgres date math: to_char(to_timestamp(...), 'YYYY-MM').
    expect(rows).toEqual([
      { bucket: "2023-11", n: 2 },
      { bucket: "2023-12", n: 1 },
    ]);
  });

  it("labels the month bucket in UTC regardless of the session timezone", async () => {
    // An instant in early December UTC that is still November in a western
    // zone: 2023-12-01 01:00:00 UTC == 2023-11-30 17:00 PST. The bucket must
    // label by UTC (matching the SQLite path and the UTC JS skeleton in
    // buildEmptyBuckets), so a non-UTC Postgres session must NOT shift it to
    // November. Without the `AT TIME ZONE 'UTC'` pin this returns "2023-11".
    const decBoundaryUtc = 1_701_392_400; // 2023-12-01T01:00:00Z
    await h.db.insert(runs).values({
      id: "r-tz",
      teamId: "t1",
      projectId: "p-unused",
      totalTests: 1,
      passed: 1,
      failed: 0,
      flaky: 0,
      skipped: 0,
      durationMs: 10,
      status: "passed",
      origin: "ci",
      createdAt: decBoundaryUtc,
      lastActivityAt: decBoundaryUtc,
    });

    // pglite defaults to UTC, which would hide the bug — force a western zone.
    await h.client.exec("SET TIME ZONE 'America/Los_Angeles';");
    try {
      const month = bucketExpr("month");
      const rows = await h.db
        .select({ bucket: month, n: count() })
        .from(runs)
        .where(eq(runs.id, "r-tz"))
        .groupBy(month);
      expect(rows).toEqual([{ bucket: "2023-12", n: 1 }]);
    } finally {
      await h.client.exec("SET TIME ZONE 'UTC';");
    }
  });

  it("emits to_char(to_timestamp(...)) for the month bucket under PG", () => {
    const frag = bucketExpr("month") as unknown as { queryChunks: unknown[] };
    const text = JSON.stringify(frag.queryChunks);
    expect(text).toContain("to_char");
    expect(text).toContain("to_timestamp");
    expect(text).not.toContain("strftime");
  });

  // --- Result-shape coercion (the Kysely "bigint-as-string" trap) ---
  // node-postgres returns int8 (count/sum) and numeric as JS STRINGS; SQLite/D1
  // return numbers. These guards prove our two coercion mechanisms.

  it("numericSql coerces a driver string to a JS number", () => {
    // pglite parses int8 to a number, so the string→number gap can't be shown
    // end-to-end here. Instead assert the decoder `numericSql` attaches does the
    // coercion — this is exactly what protects the production node-postgres path
    // where a bare `sql<number>` count would arrive as the string "42".
    const frag = numericSql(sql`count(*)`) as unknown as {
      decoder: { mapFromDriverValue: (v: unknown) => unknown };
    };
    expect(frag.decoder.mapFromDriverValue("42")).toBe(42);
    expect(typeof frag.decoder.mapFromDriverValue("42")).toBe("number");
  });

  it("a cast(… as integer) raw read returns a number through runRows", async () => {
    // The uptime-analytics pattern: raw `runRows` bypasses Drizzle's decoders,
    // so aggregates are cast to int4 in SQL (a type BOTH drivers parse to a
    // number). Proves the cast is valid Postgres and round-trips as a number.
    const rows = await runRows<{ n: number }>(
      sql`select cast(count(*) as integer) as n from teams`,
    );
    expect(typeof rows[0]?.n).toBe("number");
  });

  // --- Case-insensitive search (ILIKE) ---

  it("ILIKE matches case-insensitively on Postgres", async () => {
    await h.db.insert(teams).values({
      id: "t-like",
      slug: "like-team",
      name: "MixedCase",
      tier: "free",
      createdAt: 1_700_000_300,
    });
    const rows = await h.db
      .select()
      .from(teams)
      .where(sql`${teams.name} ilike ${"%mixedcase%"}`);
    expect(rows.map((r) => r.id)).toContain("t-like");
  });

  // `sql` is imported to confirm the real operator surface loads alongside the
  // pglite db; reference it so the import isn't flagged unused.
  it("exposes the real sql operator", () => {
    expect(typeof sql).toBe("function");
  });
});

// --- Hand-written aggregate loaders: end-to-end execution coverage ---
// The 2026-06-17 dialect worklog flagged the real follow-up as EXECUTING the
// hand-written raw aggregate queries against pglite, not just the seam, so a
// forgotten cast / dialect-ism / coercion regression FAILS a fast-lane test
// instead of only the real-postgres CI leg. These run the uptime-analytics
// loaders — the deferred adopter of the bound-param-preserving cast vocabulary
// (`castIntAggFragment`) — through `runRow`/`runRows` against the pglite-backed
// `db`, asserting the SQL is valid Postgres AND every numeric output round-trips
// as a JS `number` (not the int8 STRING node-postgres would otherwise hand back).
describe("uptime-analytics loaders (raw aggregate execution)", () => {
  const scope = makeTenantScope({
    teamId: "t1",
    projectId: "p-uptime",
    teamSlug: "acme",
    projectSlug: "uptime",
  });
  const monitorId = "mon-1";
  // A fixed "now" so window boundaries are deterministic. 2023-11-14-ish.
  const nowSec = 1_700_000_000;
  const HOUR = 3_600;
  const DAY = 86_400;

  beforeAll(async () => {
    // Spread executions across the 30-day window so the 24h / 7d / 30d buckets
    // each contain a known up/countable split:
    //   - inside 24h:  1 pass (up+countable), 1 fail (countable only)
    //   - 3 days ago:  1 degraded (up+countable; inside 7d + 30d, outside 24h)
    //   - 20 days ago: 1 pass (up+countable), 1 error (excluded from both)
    // Plus a different monitor + a different project, to prove tenant + monitor
    // scoping carves them out.
    const rows = [
      // monitor under test
      { id: "e1", off: HOUR, state: "pass", dur: 100, code: 200 },
      { id: "e2", off: 2 * HOUR, state: "fail", dur: 400, code: 500 },
      { id: "e3", off: 3 * DAY, state: "degraded", dur: 250, code: 200 },
      { id: "e4", off: 20 * DAY, state: "pass", dur: 150, code: 200 },
      // `error` is infra noise — excluded from up AND countable, and its
      // null statusCode keeps it out of the response-time buckets.
      { id: "e5", off: 5 * DAY, state: "error", dur: 0, code: null },
    ];
    for (const r of rows) {
      await h.db.insert(monitorExecutions).values({
        id: r.id,
        projectId: scope.projectId,
        monitorId,
        scheduledFor: nowSec - r.off,
        state: r.state,
        attempt: 0,
        durationMs: r.dur,
        statusCode: r.code,
        createdAt: nowSec - r.off,
      });
    }
    // Same project, DIFFERENT monitor — must not bleed into the counts.
    await h.db.insert(monitorExecutions).values({
      id: "other-mon",
      projectId: scope.projectId,
      monitorId: "mon-2",
      scheduledFor: nowSec - HOUR,
      state: "fail",
      attempt: 0,
      durationMs: 999,
      statusCode: 500,
      createdAt: nowSec - HOUR,
    });
    // DIFFERENT project, same monitorId — proves projectId scoping.
    await h.db.insert(monitorExecutions).values({
      id: "other-proj",
      projectId: "p-other",
      monitorId,
      scheduledFor: nowSec - HOUR,
      state: "pass",
      attempt: 0,
      durationMs: 50,
      statusCode: 200,
      createdAt: nowSec - HOUR,
    });
  });

  it("httpUptimeWindows returns numeric up/countable counts per window, tenant+monitor scoped", async () => {
    const res = await httpUptimeWindows({ scope, monitorId, nowSec });

    // 24h: e1 pass (up+countable), e2 fail (countable only).
    expect(res.d1).toEqual({ up: 1, countable: 2 });
    // 7d: + e3 degraded (up+countable) → up 2, countable 3.
    expect(res.d7).toEqual({ up: 2, countable: 3 });
    // 30d: + e4 pass (up+countable); e5 error excluded → up 3, countable 4.
    expect(res.d30).toEqual({ up: 3, countable: 4 });

    // The coercion guard the cast exists for: every count is a JS number, not
    // the int8 STRING node-postgres returns for an uncast sum(). pglite parses
    // the int4 cast to a number on both drivers, so a dropped cast would surface
    // as a string here on the real-postgres CI leg.
    for (const w of [res.d1, res.d7, res.d30]) {
      expect(typeof w.up).toBe("number");
      expect(typeof w.countable).toBe("number");
    }
  });

  it("httpResponseTimeBuckets buckets by hour with numeric counts + percentiles", async () => {
    const buckets = await httpResponseTimeBuckets({
      scope,
      monitorId,
      windowStartSec: nowSec - 30 * DAY,
    });

    // Only the 4 executions with a non-null statusCode AND durationMs land here
    // (e5 error has a null statusCode) → 4 distinct hour buckets (each event is
    // in its own hour given the offsets), each with one sample.
    expect(buckets).toHaveLength(4);
    for (const b of buckets) {
      // Hour index, count, and the discrete-percentile picks are all
      // cast(... as integer) — they must round-trip as JS numbers, not strings.
      expect(typeof b.bucket).toBe("number");
      expect(typeof b.cnt).toBe("number");
      expect(b.cnt).toBe(1);
      expect(typeof b.p50).toBe("number");
      expect(typeof b.p95).toBe("number");
    }
    // Sorted ascending by hour bucket (the `order by bucket`).
    const order = buckets.map((b) => b.bucket);
    expect(order).toEqual([...order].sort((a, z) => a - z));
  });
});

// ---------------------------------------------------------------------------
// Ingest /results batched upsert — EXECUTES buildResultInsertStatements against
// real Postgres so the ON CONFLICT (runId, testId) DO UPDATE, the insert-only
// createdAt, the updatedAt bump, and the IN-list child-row replacement are
// proven on the driver rather than only asserted structurally under a stub. The
// upsert needs the (runId, testId) unique index (createTableSql omits indexes),
// so it is created here; the three child tables are created too.
// ---------------------------------------------------------------------------
describe("ingest /results upsert (batched flush)", () => {
  const scope = makeTenantScope({
    teamId: "t-up",
    projectId: "p-up",
    teamSlug: "up",
    projectSlug: "up",
  });
  const RUN = "run-upsert";
  const T0 = 1_700_000_000; // prefill / run-open time
  const T1 = 1_700_003_600; // flush time (1h later)

  beforeAll(async () => {
    await h.client.exec(
      'create unique index if not exists "testResults_runId_testId_idx" on "testResults" ("runId", "testId");',
    );
    for (const t of [testTags, testAnnotations, testResultAttempts]) {
      const { name } = getTableConfig(t);
      await h.client.exec(`drop table if exists "${name}" cascade;`);
      await h.client.exec(createTableSql(t));
    }
  });

  beforeEach(async () => {
    await h.db.delete(testResults).where(eq(testResults.runId, RUN));
    await h.db.delete(testTags).where(eq(testTags.projectId, scope.projectId));
    await h.db
      .delete(testAnnotations)
      .where(eq(testAnnotations.projectId, scope.projectId));
    await h.db
      .delete(testResultAttempts)
      .where(eq(testResultAttempts.projectId, scope.projectId));
  });

  function makeResult(over: Partial<TestResultInput> = {}): TestResultInput {
    return {
      testId: "t1",
      title: "renders",
      file: "spec.ts",
      status: "passed",
      durationMs: 10,
      retryCount: 0,
      tags: [],
      annotations: [],
      attempts: [],
      ...over,
    } as TestResultInput;
  }

  /** Resolve ids, compute the delta, and run the upsert batch — the flush body. */
  async function flush(results: TestResultInput[], now: number) {
    const resolved = await resolveTestResultIds(
      scope,
      RUN,
      results.map((r) => r.testId),
    );
    const delta = computeAggregateDelta(results, resolved.prevStatusByTestId);
    await runBatch(
      (tx) =>
        buildResultInsertStatements(
          scope,
          RUN,
          results,
          now,
          resolved.existingIds,
          resolved.assignedIds,
          tx,
        ).statements,
    );
    return { delta };
  }

  it("upserts a prefilled row in place: keeps id + createdAt, refreshes status/updatedAt, replaces children", async () => {
    // Prefill a queued row + stale children, as openRun does at run open.
    await h.db.insert(testResults).values({
      id: "tr-prefill",
      projectId: scope.projectId,
      runId: RUN,
      testId: "t1",
      title: "queued title",
      file: "spec.ts",
      status: "queued",
      durationMs: 0,
      retryCount: 0,
      createdAt: T0,
      updatedAt: T0,
    });
    await h.db.insert(testTags).values({
      id: "tag-stale",
      projectId: scope.projectId,
      testResultId: "tr-prefill",
      tag: "old",
    });
    await h.db.insert(testResultAttempts).values({
      id: "att-stale",
      projectId: scope.projectId,
      testResultId: "tr-prefill",
      attempt: 0,
      status: "failed",
      durationMs: 5,
      createdAt: T0,
    });

    await flush(
      [
        makeResult({
          title: "renders ok",
          status: "passed",
          durationMs: 42,
          retryCount: 1,
          tags: ["smoke"],
          annotations: [{ type: "issue", description: "flake" }],
          attempts: [
            { attempt: 0, status: "failed", durationMs: 5 },
            { attempt: 1, status: "passed", durationMs: 42 },
          ],
        }),
      ],
      T1,
    );

    const [row] = await h.db
      .select()
      .from(testResults)
      .where(and(eq(testResults.runId, RUN), eq(testResults.testId, "t1")));
    expect(row?.id).toBe("tr-prefill"); // id preserved → child FKs stay valid
    expect(row?.status).toBe("passed"); // mutable column refreshed
    expect(row?.title).toBe("renders ok");
    expect(row?.durationMs).toBe(42);
    expect(row?.createdAt).toBe(T0); // INSERT-ONLY — not rewritten to the flush time
    expect(row?.updatedAt).toBe(T1); // last-write time

    // Child rows fully replaced: the stale set is gone, the new set is present.
    const tags = await h.db
      .select()
      .from(testTags)
      .where(eq(testTags.testResultId, "tr-prefill"));
    expect(tags.map((t) => t.tag)).toEqual(["smoke"]);
    const anns = await h.db
      .select()
      .from(testAnnotations)
      .where(eq(testAnnotations.testResultId, "tr-prefill"));
    expect(anns.map((a) => a.type)).toEqual(["issue"]);
    const atts = await h.db
      .select()
      .from(testResultAttempts)
      .where(eq(testResultAttempts.testResultId, "tr-prefill"));
    expect(atts).toHaveLength(2);
    expect(atts.some((a) => a.id === "att-stale")).toBe(false);
  });

  it("inserts a non-prefilled result fresh (createdAt = updatedAt = flush time)", async () => {
    await flush(
      [makeResult({ testId: "t-fresh", status: "failed", durationMs: 3 })],
      T1,
    );
    const [row] = await h.db
      .select()
      .from(testResults)
      .where(
        and(eq(testResults.runId, RUN), eq(testResults.testId, "t-fresh")),
      );
    expect(row?.status).toBe("failed");
    expect(row?.createdAt).toBe(T1);
    expect(row?.updatedAt).toBe(T1);
  });

  it("re-flushing the same result nets a ZERO aggregate delta (idempotent counters under serial replay)", async () => {
    await h.db.insert(testResults).values({
      id: "tr-idem",
      projectId: scope.projectId,
      runId: RUN,
      testId: "t2",
      title: "q",
      file: "c.ts",
      status: "queued",
      durationMs: 0,
      retryCount: 0,
      createdAt: T0,
      updatedAt: T0,
    });
    const result = makeResult({ testId: "t2", status: "passed", file: "c.ts" });
    // First flush: queued → passed. 'queued' is bucket-less, 'passed' isn't, so
    // +1 passed; totalTests unchanged (prev status defined by the prefill row).
    const first = await flush([result], T1);
    expect(first.delta).toMatchObject({ passed: 1, totalTests: 0 });
    // Serial replay (a reporter retry once the first committed): prev status is
    // now 'passed' → same bucket → the delta nets to zero, so the additive
    // counter UPDATE would be a no-op. This is the serial-equivalent of the
    // FOR UPDATE lock's guarantee; true concurrency needs the real-pg CI leg.
    const second = await flush([result], T1 + 10);
    expect(second.delta).toEqual({
      totalTests: 0,
      passed: 0,
      failed: 0,
      flaky: 0,
      skipped: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// Polar billing mirror — DB-backed behavior (PR 6b). Runs with billing ON by
// default (POLAR_* + caps set in beforeEach); a few tests toggle billing OFF by
// deleting POLAR_*. Exercises checkQuota's finite-Pro cap + the D9 expiry gate,
// the billing-OFF unlimited path, loadTeamBilling's state classification, the
// trial seed shape, reconcile (Polar SDK mocked), and every webhook → mirror
// writer incl. the ordering guard / idempotency / unresolved-team paths.
// ---------------------------------------------------------------------------

const BNOW = 1_700_000_000;

// Synthetic webhook payloads. The handlers read only these fields (fact 10); the
// `as unknown as` cast matches this file's existing convention for partial
// driver/SDK shapes.
function makeSubscription(o: {
  id: string;
  customerId: string;
  status: string;
  referenceId?: string;
  modifiedAt: Date | null;
  createdAt: Date;
  currentPeriodEnd: Date;
}): { data: Subscription } {
  return {
    data: {
      id: o.id,
      customerId: o.customerId,
      status: o.status,
      createdAt: o.createdAt,
      modifiedAt: o.modifiedAt,
      currentPeriodEnd: o.currentPeriodEnd,
      metadata: o.referenceId ? { referenceId: o.referenceId } : {},
    } as unknown as Subscription,
  };
}

function makeOrder(o: {
  id: string;
  customerId: string;
  referenceId?: string;
  modifiedAt: Date | null;
  createdAt: Date;
  periodEnd: Date;
}): { data: Order } {
  return {
    data: {
      id: o.id,
      customerId: o.customerId,
      createdAt: o.createdAt,
      modifiedAt: o.modifiedAt,
      metadata: o.referenceId ? { referenceId: o.referenceId } : {},
      subscription: { currentPeriodEnd: o.periodEnd },
    } as unknown as Order,
  };
}

describe("run-group skeleton (grouped read)", () => {
  const scope = makeTenantScope({
    teamId: "t-grp",
    projectId: "p-grp",
    teamSlug: "grp",
    projectSlug: "grp",
  });
  const RUN = "run-grp";
  const SHARD_RUN = "run-grp-shard";
  const REC_RUN = "run-grp-rec";
  const T0 = 1_700_100_000;

  type SeedRow = {
    testId: string;
    file: string;
    status: string;
    shardIndex?: number | null;
  };

  async function seed(runId: string, rows: SeedRow[]) {
    await h.db.delete(testResults).where(eq(testResults.runId, runId));
    await h.db.insert(testResults).values(
      rows.map((r, i) => ({
        id: `${runId}-${r.testId}`,
        projectId: scope.projectId,
        runId,
        testId: r.testId,
        title: `test ${r.testId}`,
        file: r.file,
        projectName: null,
        status: r.status,
        durationMs: 0,
        retryCount: 0,
        shardIndex: r.shardIndex ?? null,
        createdAt: T0 + i,
        updatedAt: T0 + i,
      })),
    );
  }

  beforeAll(async () => {
    // a: 2 failed + 1 passed (sev 8, total 3)
    // b: 1 failed + 1 timedout + 3 passed (failed BUCKET = 2 → sev 8, total 5)
    // c: 1 flaky + 2 passed (sev 2)   d: 2 passed (sev 0)   e: 1 skipped + 1 passed (sev 0)
    await seed(RUN, [
      { testId: "a1", file: "a.spec.ts", status: "failed" },
      { testId: "a2", file: "a.spec.ts", status: "failed" },
      { testId: "a3", file: "a.spec.ts", status: "passed" },
      { testId: "b1", file: "b.spec.ts", status: "failed" },
      { testId: "b2", file: "b.spec.ts", status: "timedout" },
      { testId: "b3", file: "b.spec.ts", status: "passed" },
      { testId: "b4", file: "b.spec.ts", status: "passed" },
      { testId: "b5", file: "b.spec.ts", status: "passed" },
      { testId: "c1", file: "c.spec.ts", status: "flaky" },
      { testId: "c2", file: "c.spec.ts", status: "passed" },
      { testId: "c3", file: "c.spec.ts", status: "passed" },
      { testId: "d1", file: "d.spec.ts", status: "passed" },
      { testId: "d2", file: "d.spec.ts", status: "passed" },
      { testId: "e1", file: "e.spec.ts", status: "skipped" },
      { testId: "e2", file: "e.spec.ts", status: "passed" },
    ]);
    await seed(SHARD_RUN, [
      { testId: "s1", file: "x.spec.ts", status: "failed", shardIndex: 1 },
      { testId: "s2", file: "x.spec.ts", status: "passed", shardIndex: 1 },
      { testId: "s3", file: "y.spec.ts", status: "passed", shardIndex: null },
      { testId: "s4", file: "y.spec.ts", status: "passed", shardIndex: null },
    ]);
    // One file with failed/flaky rows INTERLEAVED by insert time (createdAt), so
    // a pure (createdAt, id) page order would split failed rows across pages.
    // The "recommended" bucket rank must pull all failed rows ahead of flaky.
    await seed(REC_RUN, [
      { testId: "rec1", file: "big.spec.ts", status: "failed" }, // T0+0
      { testId: "rec2", file: "big.spec.ts", status: "flaky" }, // T0+1
      { testId: "rec3", file: "big.spec.ts", status: "failed" }, // T0+2
      { testId: "rec4", file: "big.spec.ts", status: "flaky" }, // T0+3
      { testId: "rec5", file: "big.spec.ts", status: "failed" }, // T0+4
    ]);
  });

  it("groups by file worst-first with per-bucket counts (timedout ∈ failed) + auto-expand flags", async () => {
    const skel = await loadRunGroupSkeleton(scope, RUN, {
      groupBy: "file",
      status: null,
      search: null,
      cursor: null,
      limit: 50,
      skipOwnershipCheck: true,
    });
    if (!skel) throw new Error("expected a skeleton");
    // sev desc, key asc: a(8) b(8) c(2) d(0) e(0). int8 counts come back as
    // JS numbers (numericSql) — the assertions on numeric equality pin that.
    expect(skel.groups.map((g) => g.key)).toEqual([
      "a.spec.ts",
      "b.spec.ts",
      "c.spec.ts",
      "d.spec.ts",
      "e.spec.ts",
    ]);
    expect(skel.groups[0]).toMatchObject({
      key: "a.spec.ts",
      total: 3,
      failed: 2,
      flaky: 0,
      passed: 1,
      skipped: 0,
      expandedByDefault: true,
    });
    expect(skel.groups[1]).toMatchObject({
      key: "b.spec.ts",
      total: 5,
      failed: 2, // 1 failed + 1 timedout
      passed: 3,
      expandedByDefault: true,
    });
    expect(skel.groups[2]).toMatchObject({
      key: "c.spec.ts",
      flaky: 1,
      passed: 2,
      expandedByDefault: true,
    });
    expect(skel.groups[3]).toMatchObject({
      key: "d.spec.ts",
      expandedByDefault: false,
    });
    expect(skel.groups[4]).toMatchObject({
      key: "e.spec.ts",
      skipped: 1,
      expandedByDefault: false,
    });
    // Page carries failing groups → the client may latch auto-expand.
    expect(skel.hasFailingGroup).toBe(true);
  });

  it("status filter narrows to failing groups (failed bucket only)", async () => {
    const skel = await loadRunGroupSkeleton(scope, RUN, {
      groupBy: "file",
      status: "failed",
      search: null,
      cursor: null,
      limit: 50,
      skipOwnershipCheck: true,
    });
    if (!skel) throw new Error("expected a skeleton");
    expect(skel.groups.map((g) => g.key)).toEqual(["a.spec.ts", "b.spec.ts"]);
    expect(skel.groups[0]).toMatchObject({ total: 2, failed: 2, passed: 0 });
    expect(skel.groups[1]).toMatchObject({ total: 2, failed: 2, passed: 0 });
  });

  it("search filter narrows to matching files (ILIKE title/file)", async () => {
    const skel = await loadRunGroupSkeleton(scope, RUN, {
      groupBy: "file",
      status: null,
      search: "c.spec",
      cursor: null,
      limit: 50,
      skipOwnershipCheck: true,
    });
    if (!skel) throw new Error("expected a skeleton");
    expect(skel.groups.map((g) => g.key)).toEqual(["c.spec.ts"]);
  });

  it("recommended filter = failed ∪ flaky groups, worst-first", async () => {
    const skel = await loadRunGroupSkeleton(scope, RUN, {
      groupBy: "file",
      status: "recommended",
      search: null,
      cursor: null,
      limit: 50,
      skipOwnershipCheck: true,
    });
    if (!skel) throw new Error("expected a skeleton");
    // a (2 failed, sev 8), b (2 failed, sev 8), c (1 flaky, sev 2); d/e drop out
    // (no failed/flaky). Counts cover only the failed/flaky rows.
    expect(skel.groups.map((g) => g.key)).toEqual([
      "a.spec.ts",
      "b.spec.ts",
      "c.spec.ts",
    ]);
    expect(skel.groups[0]).toMatchObject({ failed: 2, total: 2 });
    expect(skel.groups[2]).toMatchObject({
      key: "c.spec.ts",
      flaky: 1,
      total: 1,
    });

    // A recommended group's row page returns only its failed+flaky rows.
    const rows = await loadRunResultsPage(scope, RUN, {
      cursor: null,
      limit: 200,
      status: null,
      statusBucket: "recommended",
      group: { axis: "file", key: "b.spec.ts" },
      skipOwnershipCheck: true,
    });
    if (!rows) throw new Error("expected a page");
    expect(rows.results).toHaveLength(2); // failed + timedout (both failed bucket)
    expect(
      rows.results.every(
        (r) => r.status === "failed" || r.status === "timedout",
      ),
    ).toBe(true);
  });

  it("paginates group headers worst-first via the cursor", async () => {
    // limit 2 → page 1 = the two worst (a, b — both sev 8, key asc), nextCursor set.
    const page1 = await loadRunGroupSkeleton(scope, RUN, {
      groupBy: "file",
      status: null,
      search: null,
      cursor: null,
      limit: 2,
      skipOwnershipCheck: true,
    });
    if (!page1) throw new Error("expected page 1");
    expect(page1.groups.map((g) => g.key)).toEqual(["a.spec.ts", "b.spec.ts"]);
    expect(page1.nextCursor).not.toBeNull();

    // page 2 continues after the cursor: c (sev 2), then d, e (sev 0, key asc).
    const page2 = await loadRunGroupSkeleton(scope, RUN, {
      groupBy: "file",
      status: null,
      search: null,
      cursor: page1.nextCursor,
      limit: 2,
      skipOwnershipCheck: true,
    });
    if (!page2) throw new Error("expected page 2");
    expect(page2.groups.map((g) => g.key)).toEqual(["c.spec.ts", "d.spec.ts"]);
    // c had failures on page 1's side, but as a later page it must NOT be
    // force-expanded (fallback only applies to the first page).
    expect(page2.groups.every((g) => !g.expandedByDefault)).toBe(true);
    // c.spec.ts (flaky) is on this page → hasFailingGroup true here…
    expect(page2.hasFailingGroup).toBe(true);

    const page3 = await loadRunGroupSkeleton(scope, RUN, {
      groupBy: "file",
      status: null,
      search: null,
      cursor: page2.nextCursor,
      limit: 2,
      skipOwnershipCheck: true,
    });
    if (!page3) throw new Error("expected page 3");
    expect(page3.groups.map((g) => g.key)).toEqual(["e.spec.ts"]);
    expect(page3.nextCursor).toBeNull();
    // …but e.spec.ts is all passed/skipped → no failing group on the last page.
    expect(page3.hasFailingGroup).toBe(false);
  });

  it("recommended row pages order failed-before-flaky across page boundaries", async () => {
    // big.spec.ts interleaves failed/flaky by createdAt; a pure (createdAt, id)
    // order would put page 2's older failed rows below page 1's newer flaky rows.
    // The recommended bucket rank + ranked cursor keep all failed rows first.
    const acc: { testId: string; status: string }[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 5; i++) {
      const p = await loadRunResultsPage(scope, REC_RUN, {
        cursor,
        limit: 2,
        status: null,
        statusBucket: "recommended",
        group: { axis: "file", key: "big.spec.ts" },
        skipOwnershipCheck: true,
      });
      if (!p) throw new Error("expected a page");
      acc.push(
        ...p.results.map((r) => ({ testId: r.testId, status: r.status })),
      );
      if (!p.nextCursor) break;
      cursor = p.nextCursor;
    }
    // All 5 rows returned once, failed bucket first (id desc within a rank).
    expect(acc.map((r) => r.testId)).toEqual([
      "rec5",
      "rec3",
      "rec1",
      "rec4",
      "rec2",
    ]);
    expect(acc.map((r) => r.status)).toEqual([
      "failed",
      "failed",
      "failed",
      "flaky",
      "flaky",
    ]);
  });

  it("loadRunResultsPage restricts to one file group", async () => {
    const page = await loadRunResultsPage(scope, RUN, {
      cursor: null,
      limit: 200,
      status: null,
      group: { axis: "file", key: "a.spec.ts" },
      skipOwnershipCheck: true,
    });
    if (!page) throw new Error("expected a page");
    expect(page.results).toHaveLength(3);
    expect(new Set(page.results.map((r) => r.file))).toEqual(
      new Set(["a.spec.ts"]),
    );
  });

  it("groups by shard incl. the unsharded (null-key) fallback + filters rows by null key", async () => {
    const skel = await loadRunGroupSkeleton(scope, SHARD_RUN, {
      groupBy: "shard",
      status: null,
      search: null,
      cursor: null,
      limit: 50,
      skipOwnershipCheck: true,
    });
    if (!skel) throw new Error("expected a skeleton");
    // shard 1 has a failure (sev 4) → first; unsharded (null) sev 0 → second.
    expect(skel.groups.map((g) => g.key)).toEqual(["1", null]);
    expect(skel.groups[0]).toMatchObject({ key: "1", failed: 1, total: 2 });
    expect(skel.groups[1]).toMatchObject({ key: null, passed: 2, total: 2 });

    const nullPage = await loadRunResultsPage(scope, SHARD_RUN, {
      cursor: null,
      limit: 200,
      status: null,
      group: { axis: "shard", key: null },
      skipOwnershipCheck: true,
    });
    if (!nullPage) throw new Error("expected a page");
    expect(nullPage.results).toHaveLength(2);
    expect(nullPage.results.every((r) => r.shardIndex === null)).toBe(true);
  });

  it("groups by project into the null-key fallback when projectName is null", async () => {
    const skel = await loadRunGroupSkeleton(scope, RUN, {
      groupBy: "project",
      status: null,
      search: null,
      cursor: null,
      limit: 50,
      skipOwnershipCheck: true,
    });
    if (!skel) throw new Error("expected a skeleton");
    expect(skel.groups).toHaveLength(1);
    expect(skel.groups[0]?.key).toBeNull();
    expect(skel.groups[0]?.total).toBe(15);
  });
});

describe("jsonb columns round-trip (object in → object out, no double-encoding)", () => {
  beforeAll(async () => {
    for (const t of [auditLog, monitors]) {
      const { name } = getTableConfig(t);
      await h.client.exec(`drop table if exists "${name}" cascade;`);
      await h.client.exec(createTableSql(t));
    }
  });

  it("monitors.config survives updateMonitor as a JS object, not a JSON string", async () => {
    // Regression for the write-path double-encode: updateMonitor must store the
    // config object directly into the jsonb column (like createMonitor), not
    // JSON.stringify it — a stringified value comes back as a string and the
    // read-path parser rejects it as null, silently breaking the monitor.
    const scope = makeTenantScope({
      teamId: "t-mon",
      projectId: "p-mon",
      teamSlug: "mon",
      projectSlug: "mon",
    });
    const cfgA = HttpMonitorConfigSchema.parse({
      url: "https://a.example.com",
    });
    const cfgB = HttpMonitorConfigSchema.parse({
      url: "https://b.example.com",
    });
    await h.db.insert(monitors).values({
      id: "mon-cfg",
      teamId: scope.teamId,
      projectId: scope.projectId,
      name: "api",
      type: "http",
      enabled: 1,
      alertsEnabled: 1,
      alertTargets: null,
      source: null,
      config: cfgA,
      intervalSeconds: 60,
      schedulingStrategy: "round_robin",
      retryConfig: null,
      nextRunAt: null,
      lastEnqueuedAt: null,
      lastRunAt: null,
      lastStatus: null,
      createdBy: "u-mon",
      createdAt: 1000,
      updatedAt: 1000,
    });

    await updateMonitor(scope, "mon-cfg", { config: cfgB }, 2000);

    const [row] = await h.db
      .select({ config: monitors.config })
      .from(monitors)
      .where(eq(monitors.id, "mon-cfg"));
    // Pre-fix this is a string (JSON.stringify output) and the parse returns null.
    expect(typeof row?.config).toBe("object");
    expect(parseHttpMonitorConfig(row?.config)).toEqual(cfgB);
  });

  it("monitorExecutions.resultDetail stores + returns a JS object, never a string", async () => {
    const detail = {
      assertions: [],
      timings: { ttfbMs: 5, downloadMs: 2, totalMs: 9 },
      redirected: false,
      finalUrl: "https://example.com",
    };
    await h.db.insert(monitorExecutions).values({
      id: "me-json",
      projectId: "p-json",
      monitorId: "m-json",
      scheduledFor: 1000,
      state: "pass",
      attempt: 0,
      resultDetail: detail,
      createdAt: 1000,
    });
    const [row] = await h.db
      .select({ resultDetail: monitorExecutions.resultDetail })
      .from(monitorExecutions)
      .where(eq(monitorExecutions.id, "me-json"));
    // If the write stringified or the read didn't parse, this would be a string.
    expect(typeof row?.resultDetail).toBe("object");
    expect(row?.resultDetail).toEqual(detail);
  });

  it("auditLog.metadata round-trips an object; null stays null", async () => {
    await h.db.insert(auditLog).values([
      {
        id: "al-1",
        teamId: "t-json",
        actorUserId: "u-json",
        action: "member.role_change",
        metadata: { role: "viewer", extra: [1, 2] },
        createdAt: 1000,
      },
      {
        id: "al-2",
        teamId: "t-json",
        actorUserId: "u-json",
        action: "team.delete",
        metadata: null,
        createdAt: 1001,
      },
    ]);
    const rows = await h.db
      .select({ id: auditLog.id, metadata: auditLog.metadata })
      .from(auditLog)
      .where(eq(auditLog.teamId, "t-json"));
    const byId = new Map(rows.map((r) => [r.id, r.metadata]));
    expect(byId.get("al-1")).toEqual({ role: "viewer", extra: [1, 2] });
    expect(byId.get("al-2")).toBeNull();
  });
});

describe("user teardown (auth-boundary delete gap)", () => {
  const NOW = 1_700_000_000;

  beforeAll(async () => {
    for (const t of [
      memberships,
      memberGroupMembers,
      userState,
      userGithubAccounts,
    ]) {
      const { name } = getTableConfig(t);
      await h.client.exec(`drop table if exists "${name}" cascade;`);
      await h.client.exec(createTableSql(t));
    }
  });

  beforeEach(async () => {
    await h.db.delete(memberships);
    await h.db.delete(memberGroupMembers);
    await h.db.delete(userState);
    await h.db.delete(userGithubAccounts);
  });

  function addMember(
    id: string,
    userId: string,
    teamId: string,
    role: "owner" | "member",
  ) {
    return h.db
      .insert(memberships)
      .values({ id, userId, teamId, role, createdAt: NOW });
  }

  it("findSoleOwnerTeamIds returns only teams where the user is the LONE owner", async () => {
    await addMember("m1", "u1", "team-solo", "owner"); // sole owner → stranded
    await addMember("m2", "u1", "team-co", "owner"); // co-owned → safe
    await addMember("m3", "u2", "team-co", "owner"); // the co-owner
    await addMember("m4", "u1", "team-member", "member"); // not an owner → safe
    expect(await findSoleOwnerTeamIds("u1")).toEqual(["team-solo"]);
    expect(await findSoleOwnerTeamIds("u2")).toEqual([]);
  });

  it("assertUserDeletable throws for a sole owner, resolves for a co-owner", async () => {
    await addMember("m1", "u1", "team-solo", "owner");
    await addMember("m2", "u1", "team-co", "owner");
    await addMember("m3", "u2", "team-co", "owner");
    await expect(assertUserDeletable("u1")).rejects.toThrow(/sole owner/i);
    await expect(assertUserDeletable("u2")).resolves.toBeUndefined();
  });

  it("cleanupUserData sweeps the user's rows in one batch, leaving others intact", async () => {
    await addMember("m1", "u1", "team-a", "member");
    await addMember("m2", "u2", "team-a", "owner"); // survivor
    await h.db.insert(memberGroupMembers).values([
      { groupId: "g1", userId: "u1" },
      { groupId: "g1", userId: "u2" },
    ]);
    await h.db.insert(userState).values({ userId: "u1", updatedAt: NOW });
    await h.db
      .insert(userGithubAccounts)
      .values({ userId: "u1", githubLogin: "octo", updatedAt: NOW });

    await cleanupUserData("u1");

    const u1 = async (
      table:
        | typeof memberships
        | typeof memberGroupMembers
        | typeof userState
        | typeof userGithubAccounts,
    ) => (await h.db.select().from(table).where(eq(table.userId, "u1"))).length;
    expect(await u1(memberships)).toBe(0);
    expect(await u1(memberGroupMembers)).toBe(0);
    expect(await u1(userState)).toBe(0);
    expect(await u1(userGithubAccounts)).toBe(0);
    // u2's rows are untouched.
    expect(
      await h.db.select().from(memberships).where(eq(memberships.userId, "u2")),
    ).toHaveLength(1);
    expect(
      await h.db
        .select()
        .from(memberGroupMembers)
        .where(eq(memberGroupMembers.userId, "u2")),
    ).toHaveLength(1);
  });
});

describe("tests catalog upsert (buildTestCatalogUpsertStatements)", () => {
  const scope = makeTenantScope({
    teamId: "t-cat",
    projectId: "p-cat",
    teamSlug: "cat",
    projectSlug: "cat",
  });
  const T0 = 1_700_000_000; // first ingest
  const T1 = 1_700_003_600; // later ingest (1h)

  beforeAll(async () => {
    const { name } = getTableConfig(tests);
    await h.client.exec(`drop table if exists "${name}" cascade;`);
    await h.client.exec(createTableSql(tests));
    // createTableSql omits indexes, but the ON CONFLICT (projectId, testId)
    // upsert target REQUIRES this unique constraint to exist.
    await h.client.exec(
      'create unique index "tests_project_testId_idx" on "tests" ("projectId", "testId");',
    );
  });

  beforeEach(async () => {
    await h.db.delete(tests).where(eq(tests.projectId, scope.projectId));
  });

  async function upsert(
    entries: ReadonlyArray<{ testId: string; title: string; file: string }>,
    now: number,
  ) {
    await runBatch((tx) =>
      buildTestCatalogUpsertStatements(scope, entries, now, tx),
    );
  }

  it("inserts a fresh catalog row (firstSeenAt = lastSeenAt = ingest time)", async () => {
    await upsert([{ testId: "t1", title: "renders", file: "a.spec.ts" }], T0);
    const rows = await h.db
      .select()
      .from(tests)
      .where(eq(tests.projectId, scope.projectId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      testId: "t1",
      title: "renders",
      file: "a.spec.ts",
      firstSeenAt: T0,
      lastSeenAt: T0,
    });
  });

  it("latest-wins on re-upsert: refreshes title/file/lastSeenAt, KEEPS firstSeenAt", async () => {
    await upsert([{ testId: "t1", title: "old", file: "a.spec.ts" }], T0);
    await upsert([{ testId: "t1", title: "new", file: "b.spec.ts" }], T1);
    const rows = await h.db.select().from(tests).where(eq(tests.testId, "t1"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: "new",
      file: "b.spec.ts",
      firstSeenAt: T0, // insert-only — survives the update
      lastSeenAt: T1,
    });
  });

  it("dedups a duplicate testId within one batch (last entry wins, no ON CONFLICT double-hit)", async () => {
    // Two entries for the same testId in ONE flush — a multi-row INSERT … ON
    // CONFLICT errors ("cannot affect row a second time") if the dedup doesn't
    // collapse them before the statement runs.
    await upsert(
      [
        { testId: "dup", title: "first", file: "f.ts" },
        { testId: "dup", title: "second", file: "f.ts" },
      ],
      T0,
    );
    const rows = await h.db.select().from(tests).where(eq(tests.testId, "dup"));
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("second");
  });

  it("emits catalog rows sorted by testId (shared-lock order → no cross-run deadlock)", () => {
    // The (projectId, testId) ON CONFLICT row is shared across ALL runs of a
    // project, but the ingest txn only locks the per-run row. Every writer must
    // emit the VALUES tuples in the SAME global order or two concurrent flushes
    // can AB/BA deadlock on the row locks. Assert the builder sorts by testId
    // regardless of input order — capture the `.values()` arg, no DB needed.
    const captured: Array<{ testId: string }> = [];
    const fakeExec = {
      insert: () => ({
        values: (rows: Array<{ testId: string }>) => {
          captured.push(...rows);
          return { onConflictDoUpdate: () => Promise.resolve() };
        },
      }),
    } as unknown as Parameters<typeof buildTestCatalogUpsertStatements>[3];
    buildTestCatalogUpsertStatements(
      scope,
      [
        { testId: "t3", title: "c", file: "f" },
        { testId: "t1", title: "a", file: "f" },
        { testId: "t2", title: "b", file: "f" },
      ],
      T0,
      fakeExec,
    );
    expect(captured.map((r) => r.testId)).toEqual(["t1", "t2", "t3"]);
  });

  it("search ordering is deterministic under tied lastSeenAt (testId tiebreaker)", async () => {
    // openRun's prefill seeds a whole suite with ONE identical lastSeenAt, so a
    // top-N over lastSeenAt alone returns an arbitrary tied subset. The testId
    // tiebreaker makes it a stable total order.
    const entries = Array.from({ length: 12 }, (_, i) => ({
      testId: `z${(11 - i).toString().padStart(2, "0")}`,
      title: `test ${i}`,
      file: "spec.ts",
    }));
    await upsert(entries, T0);
    const runSearch = () =>
      h.db
        .select({ testId: tests.testId })
        .from(tests)
        .where(buildTestSearchWhere(scope, ""))
        .orderBy(desc(tests.lastSeenAt), tests.testId)
        .limit(8);
    const first = (await runSearch()).map((r) => r.testId);
    const second = (await runSearch()).map((r) => r.testId);
    expect(first).toEqual(second); // stable across requests
    const expected = entries
      .map((e) => e.testId)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, 8);
    expect(first).toEqual(expected);
  });
});

describe("Polar billing mirror (Postgres path)", () => {
  beforeEach(async () => {
    // Billing ON with known caps; tests that need billing OFF delete POLAR_*.
    billingConfig.POLAR_ACCESS_TOKEN = "polar_test";
    billingConfig.POLAR_WEBHOOK_SECRET = "whsec_test";
    billingConfig.POLAR_MODE = "sandbox";
    billingConfig.WRIGHTFUL_FREE_MONTHLY_RUNS = 1000;
    billingConfig.WRIGHTFUL_FREE_MONTHLY_TEST_RESULTS = 100000;
    billingConfig.WRIGHTFUL_FREE_ARTIFACT_BYTES = 5_368_709_120;
    billingConfig.WRIGHTFUL_PRO_MONTHLY_RUNS = 25000;
    billingConfig.WRIGHTFUL_PRO_MONTHLY_TEST_RESULTS = 5_000_000;
    billingConfig.WRIGHTFUL_PRO_ARTIFACT_BYTES = 107_374_182_400;
    billingConfig.WRIGHTFUL_QUOTA_SOFT_WARN_PCT = 90;
    polarStub.items = [];
    // Clean slate (these tables carry no FK in the test DDL, so order is free).
    await h.db.delete(usageCounters);
    await h.db.delete(teams);
  });

  it("round-trips the bigint billing-mirror columns as numbers (int8 parity)", async () => {
    await h.db.insert(teams).values({
      id: "bt-mirror",
      slug: "mirror",
      name: "Mirror",
      tier: "pro",
      createdAt: BNOW,
      polarCustomerId: "cus_1",
      polarSubscriptionId: "sub_1",
      subscriptionStatus: "active",
      currentPeriodEnd: 1_900_000_000,
      billingUpdatedAt: 1_850_000_000,
    });
    const [row] = await h.db
      .select()
      .from(teams)
      .where(eq(teams.id, "bt-mirror"));
    expect(typeof row?.currentPeriodEnd).toBe("number");
    expect(row?.currentPeriodEnd).toBe(1_900_000_000);
    expect(typeof row?.billingUpdatedAt).toBe("number");
    expect(row?.billingUpdatedAt).toBe(1_850_000_000);
    expect(row?.polarCustomerId).toBe("cus_1");
  });

  it("checkQuota gates a within-period pro at the FINITE Pro ceiling (billing ON)", async () => {
    const periodStart = monthStartSeconds(BNOW);
    await h.db.insert(teams).values({
      id: "bt-pro",
      slug: "pro",
      name: "Pro",
      tier: "pro",
      createdAt: BNOW,
      polarCustomerId: "cus_pro",
      currentPeriodEnd: BNOW + 100_000,
    });
    let res = await checkQuota("bt-pro", "runs", 1, BNOW);
    expect(res.status).toBe("ok");
    expect(res.limit).toBe(25000); // finite Pro cap, NOT Infinity
    await h.db.insert(usageCounters).values({
      id: "uc-pro",
      teamId: "bt-pro",
      periodStart,
      runsCount: 25000,
      artifactBytes: 0,
      artifactCount: 0,
      updatedAt: BNOW,
    });
    res = await checkQuota("bt-pro", "runs", 1, BNOW);
    expect(res.status).toBe("blocked"); // 25001 > 25000
  });

  it("checkQuota re-caps an EXPIRED pro to the free ceiling (D9 expiry gate, billing ON)", async () => {
    const periodStart = monthStartSeconds(BNOW);
    await h.db.insert(teams).values({
      id: "bt-exp",
      slug: "exp",
      name: "Exp",
      tier: "pro",
      createdAt: BNOW,
      polarCustomerId: "cus_exp",
      currentPeriodEnd: BNOW - BILLING_PERIOD_GRACE_SECONDS - 100, // past grace
    });
    await h.db.insert(usageCounters).values({
      id: "uc-exp",
      teamId: "bt-exp",
      periodStart,
      runsCount: 1000,
      artifactBytes: 0,
      artifactCount: 0,
      updatedAt: BNOW,
    });
    const res = await checkQuota("bt-exp", "runs", 1, BNOW);
    expect(res.limit).toBe(1000); // effective tier free
    expect(res.status).toBe("blocked"); // 1001 > 1000
  });

  it("checkQuota is UNLIMITED for every tier when billing is OFF (the only uncapped path)", async () => {
    delete billingConfig.POLAR_ACCESS_TOKEN;
    delete billingConfig.POLAR_WEBHOOK_SECRET;
    const periodStart = monthStartSeconds(BNOW);
    await h.db.insert(teams).values({
      id: "bt-free",
      slug: "free",
      name: "Free",
      tier: "free",
      createdAt: BNOW,
    });
    await h.db.insert(usageCounters).values({
      id: "uc-free",
      teamId: "bt-free",
      periodStart,
      runsCount: 10_000_000,
      artifactBytes: 0,
      artifactCount: 0,
      updatedAt: BNOW,
    });
    const res = await checkQuota("bt-free", "runs", 1, BNOW);
    expect(res.limit).toBe(Infinity);
    expect(res.status).toBe("ok"); // far past the free ceiling, but unlimited
  });

  it("loadTeamBilling classifies free / trial / paid", async () => {
    await h.db.insert(teams).values([
      { id: "b-free", slug: "f", name: "F", tier: "free", createdAt: BNOW },
      {
        id: "b-trial",
        slug: "t",
        name: "T",
        tier: "pro",
        createdAt: BNOW,
        currentPeriodEnd: BNOW + 100_000,
        polarCustomerId: null,
      },
      {
        id: "b-paid",
        slug: "p",
        name: "P",
        tier: "pro",
        createdAt: BNOW,
        currentPeriodEnd: BNOW + 100_000,
        polarCustomerId: "cus_paid",
        subscriptionStatus: "active",
      },
    ]);
    expect((await loadTeamBilling("b-free", BNOW)).state).toBe("free");
    const trial = await loadTeamBilling("b-trial", BNOW);
    expect(trial.state).toBe("trial");
    expect(trial.trialDaysLeft).not.toBeNull();
    expect((await loadTeamBilling("b-paid", BNOW)).state).toBe("paid");
  });

  it("trial seed shape: tier=pro + ~14d period + null customer re-caps to free after grace", async () => {
    // Equivalent to createTeamForUser's seed (PR 4). createTeamForUser also inserts
    // a membership row (table not created in this minimal harness), so we assert
    // the seeded VALUES + the gating consequence here.
    const TRIAL = 14 * 24 * 60 * 60;
    await h.db.insert(teams).values({
      id: "b-seed",
      slug: "seed",
      name: "Seed",
      tier: "pro",
      createdAt: BNOW,
      currentPeriodEnd: BNOW + TRIAL,
      polarCustomerId: null,
    });
    const [row] = await h.db.select().from(teams).where(eq(teams.id, "b-seed"));
    expect(row?.tier).toBe("pro");
    expect(row?.polarCustomerId).toBeNull();
    expect(row?.currentPeriodEnd).toBe(BNOW + TRIAL);
    expect(effectiveTier("pro", BNOW + TRIAL, BNOW)).toBe("pro");
    expect(
      effectiveTier(
        "pro",
        BNOW + TRIAL,
        BNOW + TRIAL + BILLING_PERIOD_GRACE_SECONDS + 1,
      ),
    ).toBe("free");
  });

  it("reconcile downgrades an expired pro whose Polar subscription is gone", async () => {
    polarStub.items = []; // no active subscription
    await h.db.insert(teams).values({
      id: "b-rec",
      slug: "rec",
      name: "Rec",
      tier: "pro",
      createdAt: BNOW,
      polarCustomerId: "cus_rec",
      currentPeriodEnd: BNOW - BILLING_PERIOD_GRACE_SECONDS - 100, // past grace
      billingUpdatedAt: 1_650_000_000,
    });
    const summary = await reconcileBilling(BNOW);
    expect(summary.checked).toBe(1);
    expect(summary.corrected).toBe(1);
    const [row] = await h.db.select().from(teams).where(eq(teams.id, "b-rec"));
    expect(row?.tier).toBe("free");
  });

  it("reconcile leaves a within-period pro alone", async () => {
    polarStub.items = [];
    await h.db.insert(teams).values({
      id: "b-rec2",
      slug: "rec2",
      name: "Rec2",
      tier: "pro",
      createdAt: BNOW,
      polarCustomerId: "cus_rec2",
      currentPeriodEnd: BNOW + 100_000,
    });
    const summary = await reconcileBilling(BNOW);
    expect(summary.corrected).toBe(0);
    const [row] = await h.db.select().from(teams).where(eq(teams.id, "b-rec2"));
    expect(row?.tier).toBe("pro");
  });

  it("reconcile does NOT bump billingUpdatedAt (the ordering guard is webhook-owned)", async () => {
    polarStub.items = [];
    const STAMP = 1_650_000_000;
    await h.db.insert(teams).values({
      id: "b-rec3",
      slug: "rec3",
      name: "Rec3",
      tier: "pro",
      createdAt: BNOW,
      polarCustomerId: "cus_rec3",
      currentPeriodEnd: BNOW - BILLING_PERIOD_GRACE_SECONDS - 100,
      billingUpdatedAt: STAMP,
    });
    await reconcileBilling(BNOW);
    const [row] = await h.db.select().from(teams).where(eq(teams.id, "b-rec3"));
    expect(row?.tier).toBe("free"); // corrected
    expect(row?.billingUpdatedAt).toBe(STAMP); // but the guard is untouched
  });

  it("reconcile is a no-op (checked:0) when billing is OFF (POLAR_ACCESS_TOKEN unset)", async () => {
    delete billingConfig.POLAR_ACCESS_TOKEN;
    await h.db.insert(teams).values({
      id: "b-rec4",
      slug: "rec4",
      name: "Rec4",
      tier: "pro",
      createdAt: BNOW,
      polarCustomerId: "cus_rec4",
      currentPeriodEnd: BNOW - 1_000_000,
    });
    const summary = await reconcileBilling(BNOW);
    expect(summary).toEqual({ checked: 0, corrected: 0 });
    const [row] = await h.db.select().from(teams).where(eq(teams.id, "b-rec4"));
    expect(row?.tier).toBe("pro"); // untouched
  });

  it("onSubscriptionActive flips tier→pro + sets ids/period, stamping modifiedAt", async () => {
    await h.db.insert(teams).values({
      id: "b-wh",
      slug: "wh",
      name: "Wh",
      tier: "free",
      createdAt: BNOW,
    });
    await onSubscriptionActive(
      makeSubscription({
        id: "sub_a",
        customerId: "cus_a",
        status: "active",
        referenceId: "b-wh",
        modifiedAt: new Date(BNOW * 1000),
        createdAt: new Date((BNOW - 10) * 1000),
        currentPeriodEnd: new Date((BNOW + 100_000) * 1000),
      }),
    );
    const [row] = await h.db.select().from(teams).where(eq(teams.id, "b-wh"));
    expect(row?.tier).toBe("pro");
    expect(row?.polarCustomerId).toBe("cus_a");
    expect(row?.polarSubscriptionId).toBe("sub_a");
    expect(row?.subscriptionStatus).toBe("active");
    expect(row?.currentPeriodEnd).toBe(BNOW + 100_000);
    expect(row?.billingUpdatedAt).toBe(BNOW); // modifiedAt epoch
  });

  it("onSubscriptionRevoked downgrades tier→free and clears the subscription id", async () => {
    await h.db.insert(teams).values({
      id: "b-rev",
      slug: "rev",
      name: "Rev",
      tier: "pro",
      createdAt: BNOW,
      polarCustomerId: "cus_r",
      polarSubscriptionId: "sub_r",
      subscriptionStatus: "active",
      currentPeriodEnd: BNOW + 100_000,
      billingUpdatedAt: BNOW - 100,
    });
    await onSubscriptionRevoked(
      makeSubscription({
        id: "sub_r",
        customerId: "cus_r",
        status: "canceled",
        referenceId: "b-rev",
        modifiedAt: new Date(BNOW * 1000),
        createdAt: new Date(BNOW * 1000),
        currentPeriodEnd: new Date((BNOW + 100_000) * 1000),
      }),
    );
    const [row] = await h.db.select().from(teams).where(eq(teams.id, "b-rev"));
    expect(row?.tier).toBe("free");
    expect(row?.subscriptionStatus).toBe("revoked");
    expect(row?.polarSubscriptionId).toBeNull();
  });

  it("onSubscriptionCanceled is status-only (keeps tier=pro and the period)", async () => {
    await h.db.insert(teams).values({
      id: "b-can",
      slug: "can",
      name: "Can",
      tier: "pro",
      createdAt: BNOW,
      polarCustomerId: "cus_c",
      currentPeriodEnd: BNOW + 100_000,
      billingUpdatedAt: BNOW - 100,
    });
    await onSubscriptionCanceled(
      makeSubscription({
        id: "sub_c",
        customerId: "cus_c",
        status: "canceled",
        referenceId: "b-can",
        modifiedAt: new Date(BNOW * 1000),
        createdAt: new Date(BNOW * 1000),
        currentPeriodEnd: new Date((BNOW + 100_000) * 1000),
      }),
    );
    const [row] = await h.db.select().from(teams).where(eq(teams.id, "b-can"));
    expect(row?.tier).toBe("pro"); // unchanged
    expect(row?.subscriptionStatus).toBe("canceled");
    expect(row?.currentPeriodEnd).toBe(BNOW + 100_000); // unchanged
  });

  it("onOrderPaid refreshes the period from subscription.currentPeriodEnd + keeps pro", async () => {
    await h.db.insert(teams).values({
      id: "b-ord",
      slug: "ord",
      name: "Ord",
      tier: "pro",
      createdAt: BNOW,
      polarCustomerId: "cus_o",
      currentPeriodEnd: BNOW + 10,
      billingUpdatedAt: BNOW - 100,
    });
    await onOrderPaid(
      makeOrder({
        id: "ord_1",
        customerId: "cus_o",
        referenceId: "b-ord",
        modifiedAt: new Date(BNOW * 1000),
        createdAt: new Date(BNOW * 1000),
        periodEnd: new Date((BNOW + 200_000) * 1000),
      }),
    );
    const [row] = await h.db.select().from(teams).where(eq(teams.id, "b-ord"));
    expect(row?.tier).toBe("pro");
    expect(row?.currentPeriodEnd).toBe(BNOW + 200_000);
  });

  it("ordering guard: a stale active after a newer revoked stays free", async () => {
    await h.db.insert(teams).values({
      id: "b-guard",
      slug: "og",
      name: "OG",
      tier: "pro",
      createdAt: BNOW,
      polarCustomerId: "cus_g",
      polarSubscriptionId: "sub_g",
      subscriptionStatus: "active",
      currentPeriodEnd: BNOW + 100_000,
      billingUpdatedAt: BNOW - 1000,
    });
    // Newer revoked (modifiedAt = BNOW) → free.
    await onSubscriptionRevoked(
      makeSubscription({
        id: "sub_g",
        customerId: "cus_g",
        status: "canceled",
        referenceId: "b-guard",
        modifiedAt: new Date(BNOW * 1000),
        createdAt: new Date(BNOW * 1000),
        currentPeriodEnd: new Date((BNOW + 100_000) * 1000),
      }),
    );
    // Stale active (older modifiedAt) → ignored.
    await onSubscriptionActive(
      makeSubscription({
        id: "sub_g",
        customerId: "cus_g",
        status: "active",
        referenceId: "b-guard",
        modifiedAt: new Date((BNOW - 500) * 1000),
        createdAt: new Date((BNOW - 500) * 1000),
        currentPeriodEnd: new Date((BNOW + 100_000) * 1000),
      }),
    );
    const [row] = await h.db
      .select()
      .from(teams)
      .where(eq(teams.id, "b-guard"));
    expect(row?.tier).toBe("free"); // the stale active did not resurrect pro
  });

  it("is idempotent: a duplicate active yields the same end state", async () => {
    await h.db.insert(teams).values({
      id: "b-idem",
      slug: "id",
      name: "Id",
      tier: "free",
      createdAt: BNOW,
    });
    const payload = makeSubscription({
      id: "sub_i",
      customerId: "cus_i",
      status: "active",
      referenceId: "b-idem",
      modifiedAt: new Date(BNOW * 1000),
      createdAt: new Date(BNOW * 1000),
      currentPeriodEnd: new Date((BNOW + 100_000) * 1000),
    });
    await onSubscriptionActive(payload);
    await onSubscriptionActive(payload); // duplicate delivery
    const [row] = await h.db.select().from(teams).where(eq(teams.id, "b-idem"));
    expect(row?.tier).toBe("pro");
    expect(row?.currentPeriodEnd).toBe(BNOW + 100_000);
    expect(row?.billingUpdatedAt).toBe(BNOW);
  });

  it("unresolved teamId (no metadata.referenceId) writes nothing", async () => {
    await h.db.insert(teams).values({
      id: "b-unres",
      slug: "un",
      name: "Un",
      tier: "free",
      createdAt: BNOW,
    });
    await onSubscriptionActive(
      makeSubscription({
        id: "sub_u",
        customerId: "cus_u",
        status: "active",
        // no referenceId → unresolved
        modifiedAt: new Date(BNOW * 1000),
        createdAt: new Date(BNOW * 1000),
        currentPeriodEnd: new Date((BNOW + 100_000) * 1000),
      }),
    );
    const [row] = await h.db
      .select()
      .from(teams)
      .where(eq(teams.id, "b-unres"));
    expect(row?.tier).toBe("free"); // untouched (handler logged + returned)
  });
});
