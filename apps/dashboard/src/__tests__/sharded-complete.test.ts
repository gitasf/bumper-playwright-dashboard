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

/**
 * Deferred-finalize behavior for sharded runs, executed against a real Postgres
 * (in-process pglite) so the `FOR UPDATE` lock + `ON CONFLICT` upsert + the
 * per-shard count actually run, not just typecheck.
 *
 * The fix under test: a sharded suite shares one `runs` row, so finalizing on
 * the FIRST shard's /complete would flip the run terminal while siblings still
 * stream. `completeRun` instead records a `runShards` row per shard and keeps
 * the run at status='running' until every shard has reported, then takes the
 * worst status across shards. `finalizeStaleRun` is shard-aware for the case a
 * shard dies and the watchdog force-finalizes an incomplete run.
 */

const h = await vi.hoisted(async () => {
  const schema = await import("../../db/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  const db = drizzle(client, { schema });
  return {
    db,
    client: {
      exec: (s: string) => client.exec(s),
      close: () => client.close(),
    },
  };
});

// `void/db` → the pglite instance, with the REAL Drizzle operators from the
// non-intercepted `void/_db` entry.
vi.mock("void/db", async () => {
  const ops = await vi.importActual<Record<string, unknown>>("void/_db");
  return { ...ops, db: h.db };
});
// Empty env → GitHub App off, so `maybePostGithubCheck` is a no-op (no network).
vi.mock("void/env", () => ({ env: {} }));
// The realtime broadcasts are out of scope here — swallow them.
vi.mock("@/realtime/publish", () => ({
  broadcastRunRoom: () => Promise.resolve(),
  broadcastProjectRoom: () => Promise.resolve(),
}));

const { completeRun, finalizeStaleRun } = await import("@/lib/ingest");
const { makeTenantScope } = await import("@/lib/scope");
const { runs, runShards, teams, testResults } = await import("../../db/schema");
const { and, eq } = await import("void/_db");
const { getTableConfig } = await import("void/schema-pg");

function pgType(columnType: string): string {
  if (columnType.includes("BigInt")) return "bigint";
  if (columnType.includes("Integer")) return "integer";
  return "text";
}

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

const SCOPE = makeTenantScope({
  teamId: "team-1",
  projectId: "proj-1",
  teamSlug: "acme",
  projectSlug: "web",
});

/** Seed a fresh streaming run row directly (bypassing openRun's side effects). */
async function seedRun(id: string, expectedShards: number | null) {
  await h.db.insert(runs).values({
    id,
    teamId: SCOPE.teamId,
    projectId: SCOPE.projectId,
    idempotencyKey: id,
    totalTests: 0,
    expectedShards,
    passed: 0,
    failed: 0,
    flaky: 0,
    skipped: 0,
    durationMs: 0,
    status: "running",
    createdAt: 1000,
    lastActivityAt: 1000,
    completedAt: null,
    origin: "ci",
  });
}

async function readRun(id: string) {
  const rows = await h.db
    .select({ status: runs.status, completedAt: runs.completedAt })
    .from(runs)
    .where(eq(runs.id, id));
  return rows[0]!;
}

async function shardCount(runId: string) {
  const rows = await h.db
    .select({ shardIndex: runShards.shardIndex })
    .from(runShards)
    .where(
      and(eq(runShards.projectId, SCOPE.projectId), eq(runShards.runId, runId)),
    );
  return rows.length;
}

/** Complete one shard of a sharded run. */
function completeShard(
  runId: string,
  index: number,
  total: number,
  status: "passed" | "failed" | "timedout" | "interrupted",
  completedAt: number,
) {
  return completeRun(
    SCOPE,
    runId,
    { status, durationMs: 100 * index, shard: { index, total } },
    completedAt,
  );
}

beforeAll(async () => {
  for (const t of [teams, runs, runShards, testResults]) {
    const { name } = getTableConfig(t);
    await h.client.exec(`drop table if exists "${name}" cascade;`);
    await h.client.exec(createTableSql(t));
  }
  // ON CONFLICT on runShards needs the unique index the schema declares (the
  // DDL helper omits indexes).
  await h.client.exec(
    `create unique index "runShards_project_run_shard_idx" on "runShards" ("projectId","runId","shardIndex");`,
  );
});

afterAll(async () => {
  await h.client.close();
});

beforeEach(async () => {
  for (const t of [teams, runs, runShards, testResults]) {
    const { name } = getTableConfig(t);
    await h.client.exec(`delete from "${name}";`);
  }
});

describe("completeRun — sharded deferred finalize", () => {
  it("stays 'running' until the LAST shard completes, then takes the worst status", async () => {
    await seedRun("run-a", 3);

    // Shard 1 passes — the run must NOT flip terminal (the bug).
    const r1 = await completeShard("run-a", 1, 3, "passed", 2001);
    expect(r1).toEqual({ kind: "ok", status: "running" });
    expect(await readRun("run-a")).toEqual({
      status: "running",
      completedAt: null,
    });

    // Shard 2 fails — still waiting on shard 3, so still running.
    await completeShard("run-a", 2, 3, "failed", 2002);
    expect(await readRun("run-a")).toEqual({
      status: "running",
      completedAt: null,
    });

    // Shard 3 (the last) passes — now the run finalizes to the WORST outcome
    // (failed from shard 2), with completedAt = max across shards.
    const r3 = await completeShard("run-a", 3, 3, "passed", 2003);
    expect(r3.kind).toBe("ok");
    expect(await readRun("run-a")).toEqual({
      status: "failed",
      completedAt: 2003,
    });
    expect(await shardCount("run-a")).toBe(3);
  });

  it("finalizes to 'passed' when every shard passes", async () => {
    await seedRun("run-b", 2);
    await completeShard("run-b", 1, 2, "passed", 3001);
    expect((await readRun("run-b")).status).toBe("running");
    await completeShard("run-b", 2, 2, "passed", 3002);
    expect(await readRun("run-b")).toEqual({
      status: "passed",
      completedAt: 3002,
    });
  });

  it("is idempotent under a retried /complete — no double-count, terminal status stable", async () => {
    await seedRun("run-c", 2);
    await completeShard("run-c", 1, 2, "failed", 4001);
    await completeShard("run-c", 2, 2, "passed", 4002);
    expect(await readRun("run-c")).toEqual({
      status: "failed",
      completedAt: 4002,
    });
    expect(await shardCount("run-c")).toBe(2);

    // Reporter retries shard 2's /complete: upsert updates in place, the count
    // stays 2, and the run remains 'failed'.
    await completeShard("run-c", 2, 2, "passed", 4002);
    expect(await shardCount("run-c")).toBe(2);
    expect((await readRun("run-c")).status).toBe("failed");
  });

  it("does NOT wait on shards for a non-sharded run (legacy immediate finalize)", async () => {
    await seedRun("run-d", null);
    // No shard field, expectedShards null → the run flips on this single
    // /complete via the legacy severity merge.
    const r = await completeRun(
      SCOPE,
      "run-d",
      { status: "passed", durationMs: 50 },
      5001,
    );
    expect(r).toEqual({ kind: "ok", status: "passed" });
    expect(await readRun("run-d")).toEqual({
      status: "passed",
      completedAt: 5001,
    });
    expect(await shardCount("run-d")).toBe(0);
  });
});

describe("finalizeStaleRun — shard-aware watchdog", () => {
  it("surfaces a completed shard's failure instead of masking it as 'interrupted'", async () => {
    await seedRun("run-e", 3);
    // 2 of 3 shards completed (one failed); shard 3 died, so the run is stuck.
    await completeShard("run-e", 1, 3, "passed", 6001);
    await completeShard("run-e", 2, 3, "failed", 6002);
    expect((await readRun("run-e")).status).toBe("running");

    await finalizeStaleRun(
      { id: "run-e", projectId: SCOPE.projectId, teamId: SCOPE.teamId },
      6100,
    );
    // A real failure outranks 'interrupted' — the run is recorded 'failed'.
    expect(await readRun("run-e")).toEqual({
      status: "failed",
      completedAt: 6100,
    });
  });

  it("records an incomplete all-passing run as 'interrupted'", async () => {
    await seedRun("run-f", 3);
    await completeShard("run-f", 1, 3, "passed", 7001);
    await finalizeStaleRun(
      { id: "run-f", projectId: SCOPE.projectId, teamId: SCOPE.teamId },
      7100,
    );
    expect(await readRun("run-f")).toEqual({
      status: "interrupted",
      completedAt: 7100,
    });
  });

  it("records a non-sharded abandoned run as 'interrupted' (unchanged)", async () => {
    await seedRun("run-g", null);
    await finalizeStaleRun(
      { id: "run-g", projectId: SCOPE.projectId, teamId: SCOPE.teamId },
      8100,
    );
    expect(await readRun("run-g")).toEqual({
      status: "interrupted",
      completedAt: 8100,
    });
  });
});
