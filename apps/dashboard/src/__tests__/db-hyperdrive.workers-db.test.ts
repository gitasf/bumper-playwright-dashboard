/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";

/**
 * Smoke test for the PRODUCTION data path: node-postgres loads, connects, and
 * queries over a real Hyperdrive binding INSIDE workerd. This is the one thing
 * nothing else covers — `pg-integration/` exercises the data seam and
 * result shapes against node-postgres, but in Node, never through workerd or a
 * Hyperdrive binding. (So we don't re-derive the seam here; we just prove the
 * prod driver loads and works in the prod runtime.)
 *
 * Self-skips when no Hyperdrive binding is configured (no local Postgres) — see
 * vitest.workers.db.config.ts, which wires the binding from DATABASE_URL.
 */
const hyperdrive = (env as { HYPERDRIVE?: { connectionString: string } })
  .HYPERDRIVE;

async function connect() {
  const { default: pg } = await import("pg");
  const client = new pg.Client({
    connectionString: hyperdrive!.connectionString,
  });
  await client.connect();
  return client;
}

describe.skipIf(!hyperdrive)("db over Hyperdrive (workerd)", () => {
  it("loads node-postgres and runs a query over the Hyperdrive binding", async () => {
    const client = await connect();
    try {
      const r = await client.query("select 1 as one");
      expect(r.rows[0].one).toBe(1);
    } finally {
      await client.end();
    }
  });

  it("behaves like the production driver (int8 comes back as a string)", async () => {
    // count() is int8; node-postgres yields a JS string. Confirms the
    // Hyperdrive proxy preserves the real node-postgres result shapes — the
    // behavior the analytics seam's `numericSql` / `cast(… as integer)` exist
    // to handle (and that the pglite Node lane can't reproduce).
    const client = await connect();
    try {
      const r = await client.query(
        "select count(*) as n from (values (1),(2),(3)) t",
      );
      expect(typeof r.rows[0].n).toBe("string");
      expect(r.rows[0].n).toBe("3");
    } finally {
      await client.end();
    }
  });
});
