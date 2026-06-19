// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

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

const { changedRows, runBatch, isUniqueViolation } =
  await import("@/lib/db-batch");
const { runRows } = await import("@/lib/db-run");
const { bucketExpr } = await import("@/lib/analytics/bucketing-sql");
const { numericSql } = await import("@/lib/db/sql-ops");
const { chunkByParams } = await import("@/lib/ingest");
const { projects, runs, teams, usageCounters } =
  await import("../../db/schema");
const { count, eq, sql } = await import("void/_db");
const { getTableConfig } = await import("void/schema-pg");

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
  for (const t of [teams, projects, runs, usageCounters]) {
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
