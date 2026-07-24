// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

/**
 * Numeric/int8-coercion + analytics-SQL integration — split out of the former
 * monolithic `pg-integration.test.ts` (see docs/worklog/2026-07-11-split-pg-integration-tests.md).
 * This file owns the data-seam + hand-written aggregate domain: `runBatch`
 * transaction atomicity, `chunkByParams`'s 65535-param chunking,
 * `changedRows`/`isUniqueViolation` driver-result reads, `mergeRunStatusSql`'s
 * full status-matrix parity with the JS reference, `bucketExpr`'s UTC month
 * bucketing, the `numericSql`/`cast(… as integer)` int8-as-string coercion
 * guards, ILIKE case-insensitive search, and the uptime-analytics raw
 * aggregate loaders (`httpUptimeWindows` / `httpResponseTimeBuckets`) —
 * executed against the real schema (pglite by default, real node-postgres
 * under PG_TEST_URL). See `./harness.ts` for the shared hoisted-mock boot
 * dance.
 */

// Build the backing Drizzle instance BEFORE any import of the modules under
// test resolves `void/db` (vi.hoisted runs first).
const h = await vi.hoisted(async () => {
  const { buildHarness } = await import("./harness");
  return buildHarness();
});

// `void/db` → the harness instance, with the REAL Drizzle operators (incl.
// `sql`) from the non-intercepted `void/_db` entry.
vi.mock("void/db", async () => {
  const ops = await vi.importActual<Record<string, unknown>>("void/_db");
  return { ...ops, db: h.db };
});

// `mergeRunStatusSql` etc. come from `@/lib/ingest`, which broadcasts to
// `void/ws` rooms elsewhere in that module — swallow for consistency with the
// rest of this directory (unused here, harmless).
vi.mock("@/realtime/publish", () => ({
  broadcastRunRoom: () => Promise.resolve(),
  broadcastProjectRoom: () => Promise.resolve(),
}));

const { resetTables } = await import("./harness");
const { changedRows, runBatch, isUniqueViolation } =
  await import("@/lib/db/batch");
const { runRows } = await import("@/lib/runs/db");
const { bucketExpr } = await import("@/lib/analytics/bucketing-sql");
const { numericSql } = await import("@/lib/db/sql-ops");
const { latestPerTestRn } = await import("@/lib/analytics/per-test");
const { chunkByParams, mergeRunStatus, mergeRunStatusSql } =
  await import("@/lib/ingest");
const { makeTenantScope } = await import("@/lib/scope");
const { httpResponseTimeBuckets, httpUptimeWindows } =
  await import("@/lib/monitors/http/uptime-analytics");
const { countTeamTestResults, monthStartSeconds } = await import("@/lib/usage");
const { teams, usageCounters, runs, projects, testResults, monitorExecutions } =
  await import("../../../db/schema");
const { count, eq, sql } = await import("void/_db");

beforeAll(async () => {
  await resetTables(h.client, [
    teams,
    projects,
    runs,
    testResults,
    usageCounters,
    monitorExecutions,
  ]);
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

  it("latestPerTestRn's rn is a number, not an int8 string, so r.rn === 1 holds", async () => {
    // Regression guard: flaky.server.ts's `loadSparklinesAndMeta` reads this
    // `rn` back in JS and does `r.rn === 1` to pick the latest title/file.
    // `row_number()` is int8 on Postgres — node-postgres returns int8 as a
    // STRING, so an uncast `rn` would make `"1" === 1` always false and
    // silently kill that branch on real pg (pglite returns a number here,
    // which is why this needs the real-pg CI leg, not just this fast lane).
    // Same testId across TWO runs (distinct runIds) — the realistic shape
    // latestPerTestRn ranks (partition by testId, latest createdAt first). Using
    // one runId for both rows would violate the (runId, testId) unique index.
    const testId = "rn-test-cast";
    const runIdA = "run-rn-cast-a";
    const runIdB = "run-rn-cast-b";
    await h.db.delete(testResults).where(eq(testResults.testId, testId));
    await h.db.insert(testResults).values([
      {
        id: `${runIdA}-1`,
        projectId: "p-rn",
        runId: runIdA,
        testId,
        title: "older",
        file: "a.spec.ts",
        projectName: null,
        status: "passed",
        durationMs: 0,
        retryCount: 0,
        shardIndex: null,
        createdAt: 1_700_000_000,
        updatedAt: 1_700_000_000,
      },
      {
        id: `${runIdB}-1`,
        projectId: "p-rn",
        runId: runIdB,
        testId,
        title: "newer",
        file: "b.spec.ts",
        projectName: null,
        status: "passed",
        durationMs: 0,
        retryCount: 0,
        shardIndex: null,
        createdAt: 1_700_000_100,
        updatedAt: 1_700_000_100,
      },
    ]);

    const rows = await runRows<{ testId: string; title: string; rn: number }>(
      sql`
        with ranked as (
          select tr."testId" as "testId", tr.title as title, ${latestPerTestRn("rn")}
          from "testResults" tr
          where tr."testId" = ${testId}
        )
        select "testId", title, rn from ranked order by rn asc
      `,
    );

    expect(rows).toHaveLength(2);
    expect(typeof rows[0]?.rn).toBe("number");
    expect(rows[0]).toMatchObject({ rn: 1, title: "newer" });
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
