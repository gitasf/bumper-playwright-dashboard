// Shared boot logic for the `pg-integration/` test directory (split out of
// the former monolithic `pg-integration.test.ts` — see
// docs/worklog/2026-07-11-split-pg-integration-tests.md). Every file in this
// directory needs the SAME hoisted-mock dance — build the backing Drizzle
// instance BEFORE any import of the modules under test resolves `void/db`
// (`vi.hoisted` runs first) — because `vi.mock` is per-test-file and can't be
// shared across files. This module holds the boot logic + DDL helpers once so
// each file's own `vi.hoisted` + `vi.mock` boilerplate stays minimal and
// identical. NOT matched by the vitest include glob
// (`src/**/__tests__/**/*.test.{ts,tsx}`) — this file doesn't end in
// `.test.ts`, so it's a plain helper module, not a suite of its own.
//
// Two variants of the SAME suite (Kysely's pattern), so a divergence the
// surrogate hides shows up as a CI diff:
//   - PG_TEST_URL set  → REAL Postgres via node-postgres (the production
//     driver). This is the authority — it reproduces node-postgres result
//     shapes pglite cannot, e.g. int8/numeric returned as STRINGS (the bug
//     class behind `numericSql`/`cast(… as integer)`; see
//     project_pg_pglite_int8_string_trap). Run in CI against a `services:`
//     Postgres. `max: 1` so a `SET TIME ZONE` test's effect persists across
//     queries within a file (a multi-connection pool would scatter them).
//   - unset → in-process pglite (WASM Postgres) — the fast, no-infra default
//     for local dev runs. Each file gets its OWN fresh in-process instance,
//     so pglite files are trivially isolated from one another.
//
// Real-Postgres isolation: all files in this directory share ONE database
// under PG_TEST_URL, so running them in parallel lets one file's `resetTables`
// drop a table another file is mid-assertion on. This is enforced in
// `vite.config.ts` as `fileParallelism: !process.env.PG_TEST_URL` — derived from
// the same variable that selects the shared database, so any invocation
// (`pnpm test`, a single-file run, CI) serializes automatically. The CI job also
// passes `--no-file-parallelism` (.github/workflows/ci.yml); that is now
// redundant reinforcement rather than the only thing holding this up. The
// pglite lane needs none of it — each file is a separate in-process DB — and
// keeps running fully parallel.
//
// If you ever need these files to run concurrently against real Postgres, the
// fix is per-file isolation (a schema or database per file, with the raw `pg`
// Clients in `team-lock-order.test.ts` pointed at the same schema), not
// relaxing the flag.
import { getTableConfig } from "void/schema-pg";

/**
 * Refuse a `PG_TEST_URL` that does not name a disposable database.
 *
 * {@link resetTables} runs `DROP TABLE … CASCADE` on every table a suite
 * touches, so pointing this variable at a database anyone cares about destroys
 * it — and nothing else in the harness would notice, because dropping tables is
 * the harness's normal behaviour.
 *
 * The rule: the database name must be `test` or end in `_test`. That is the part
 * of the URL that actually encodes intent. Host is deliberately NOT checked —
 * CI service containers are reachable under assorted hostnames, so a
 * localhost-only rule would reject legitimate setups while still permitting the
 * dangerous case (a production database that happens to run locally).
 *
 * There is intentionally no opt-out. An escape hatch for "drop every table in
 * this database" is the kind of thing that ends up exported in a shell profile,
 * and there is no legitimate reason to run these suites against a database whose
 * contents matter.
 */
export function assertDisposableTestDatabase(url: string): void {
  let database: string;
  try {
    database = decodeURIComponent(new URL(url).pathname).replace(/^\//, "");
  } catch {
    // Never interpolate the URL itself into these messages — a connection
    // string routinely carries a password, and both errors land in CI logs.
    // The database name is the only part worth reporting, and it is safe.
    throw new Error(
      "PG_TEST_URL is not a valid URL.\n" +
        "Expected something like postgres://user@localhost:5432/wrightful_test",
    );
  }
  if (!/(?:^|_)test$/.test(database)) {
    throw new Error(
      `Refusing to run pg-integration against database "${database || "(none)"}".\n` +
        "These suites DROP every table they touch, so the database name must end " +
        'in "_test" (or be exactly "test") to confirm it is disposable.\n' +
        "Create a throwaway database instead, e.g. `createdb wrightful_test`.",
    );
  }
}

/**
 * Build the backing Drizzle instance for one pg-integration test file. Call
 * this from inside a `vi.hoisted(async () => { ... })` block via a dynamic
 * `await import("./harness")` — the dynamic import (rather than a static
 * top-level one) is what lets the instance be built, and `void/db` mocked to
 * return it, before any downstream import of the modules under test resolves
 * `void/db` for real.
 */
export async function buildHarness() {
  const schema = await import("../../../db/schema");
  const url = process.env.PG_TEST_URL;
  if (url) {
    assertDisposableTestDatabase(url);
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
}

export type Harness = Awaited<ReturnType<typeof buildHarness>>;

/** Map a Drizzle pg column type to its CREATE TABLE SQL type. */
function pgType(columnType: string): string {
  if (columnType.includes("BigInt")) return "bigint";
  if (columnType.includes("Integer")) return "integer";
  if (columnType.includes("Jsonb")) return "jsonb";
  return "text";
}

/**
 * Derive `CREATE TABLE` DDL straight from the `schema.pg` table config — so
 * the test DDL can't drift from the schema (no hand-written column list).
 * Columns + single-column PKs only; FKs and indexes are omitted (not needed
 * to exercise the seam, and skipping FKs sidesteps insertion-order
 * constraints).
 */
export function createTableSql(
  table: Parameters<typeof getTableConfig>[0],
): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const parts = [`"${c.name}"`, pgType(c.columnType)];
    if (c.primary) parts.push("primary key");
    if (c.notNull && !c.primary) parts.push("not null");
    return parts.join(" ");
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

/**
 * Drop-then-create the given tables from their live schema config. Harmless
 * against a fresh pglite instance; re-runnable against a PERSISTENT Postgres
 * (a `services:` container is fresh per job, but a locally-reused one would
 * already hold the tables).
 */
export async function resetTables(
  client: Harness["client"],
  tables: ReadonlyArray<Parameters<typeof getTableConfig>[0]>,
) {
  for (const t of tables) {
    const { name } = getTableConfig(t);
    await client.exec(`drop table if exists "${name}" cascade;`);
    await client.exec(createTableSql(t));
  }
}
