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
const { chunkByParams, mergeRunStatus, mergeRunStatusSql } =
  await import("@/lib/ingest");
const { makeTenantScope } = await import("@/lib/scope");
const { httpResponseTimeBuckets, httpUptimeWindows } =
  await import("@/lib/monitors/http/uptime-analytics");
const { monitorExecutions, projects, runs, teams, testResults, usageCounters } =
  await import("../../db/schema");
const { count, eq, sql } = await import("void/_db");
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
        testResultsCount: 0,
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
      testResultsCount: 0,
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
      testResultsCount: 0,
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
      testResultsCount: 0,
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
