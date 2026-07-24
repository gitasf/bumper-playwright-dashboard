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
import type { OpenRunPayload } from "@/lib/schemas";

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

vi.mock("void/db", async () => {
  const ops = await vi.importActual<Record<string, unknown>>("void/_db");
  return { ...ops, db: h.db };
});
vi.mock("void/env", () => ({ env: { WRIGHTFUL_MAX_TEST_RESULTS_PER_RUN: 3 } }));
vi.mock("@/realtime/publish", () => ({
  broadcastRunRoom: () => Promise.resolve(),
  broadcastProjectRoom: () => Promise.resolve(),
}));

const { appendRunResults, openRun, RunRowCapExceededError } =
  await import("@/lib/ingest");
const { makeTenantScope } = await import("@/lib/scope");
const {
  runs,
  runShards,
  teams,
  testResults,
  testResultAttempts,
  testTags,
  testAnnotations,
  tests,
} = await import("../../db/schema");
const { eq } = await import("void/_db");
const { getTableConfig } = await import("void/schema-pg");

function pgType(columnType: string): string {
  if (columnType.includes("BigInt")) return "bigint";
  if (columnType.includes("Integer")) return "integer";
  if (columnType.includes("Jsonb")) return "jsonb";
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
const NOW = 1_000_000;

async function seedRun(id: string, totalTests: number) {
  await h.db.insert(runs).values({
    id,
    teamId: SCOPE.teamId,
    projectId: SCOPE.projectId,
    idempotencyKey: id,
    totalTests,
    passed: 0,
    failed: 0,
    flaky: 0,
    skipped: 0,
    durationMs: 0,
    status: "running",
    origin: "ci",
    createdAt: NOW,
    lastActivityAt: NOW,
    completedAt: null,
  } as never);
}

function batch(...testIds: string[]) {
  return {
    results: testIds.map((testId) => ({
      testId,
      title: "adds",
      file: "math.spec.ts",
      status: "passed" as const,
      durationMs: 1,
      retryCount: 0,
      attempts: [],
      tags: [],
      annotations: [],
    })),
  };
}

async function seedExistingResults(runId: string, ...testIds: string[]) {
  await h.db.insert(testResults).values(
    testIds.map((testId, index) => ({
      id: `existing-${runId}-${index}`,
      projectId: SCOPE.projectId,
      runId,
      testId,
      title: testId,
      file: "seed.spec.ts",
      status: "passed",
      durationMs: 1,
      retryCount: 0,
      createdAt: NOW,
      updatedAt: NOW,
    })),
  );
}

async function readState(runId: string) {
  const [run] = await h.db
    .select({ totalTests: runs.totalTests })
    .from(runs)
    .where(eq(runs.id, runId));
  const rows = await h.db
    .select({ id: testResults.id })
    .from(testResults)
    .where(eq(testResults.runId, runId));
  return { totalTests: run?.totalTests, persistedRows: rows.length };
}

beforeAll(async () => {
  // `runShards` backs the duplicate-open path's stale-shard cleanup DELETE.
  for (const t of [
    teams,
    runs,
    runShards,
    testResults,
    testResultAttempts,
    testTags,
    testAnnotations,
    tests,
  ]) {
    const { name } = getTableConfig(t);
    await h.client.exec(`drop table if exists "${name}" cascade;`);
    await h.client.exec(createTableSql(t));
  }
  await h.client.exec(
    'create unique index "testResults_runId_testId_idx" on "testResults" ("runId", "testId");',
  );
  await h.client.exec(
    'create unique index "tests_project_testId_idx" on "tests" ("projectId", "testId");',
  );
});
afterAll(async () => {
  await h.client.close();
});
beforeEach(async () => {
  for (const t of [
    testTags,
    testAnnotations,
    testResultAttempts,
    tests,
    testResults,
    runShards,
    runs,
    teams,
  ]) {
    const { name } = getTableConfig(t);
    await h.client.exec(`delete from "${name}";`);
  }
});

describe("appendRunResults — per-run row cap", () => {
  it("refuses appends once totalTests reaches the ceiling (413-mapped rowCapExceeded)", async () => {
    await seedRun("run-cap", 3);
    const outcome = await appendRunResults(
      SCOPE,
      "run-cap",
      batch("t-new"),
      NOW,
    );
    expect(outcome).toEqual({ kind: "rowCapExceeded", limit: 3, count: 4 });
  });

  it("refuses when already over the ceiling", async () => {
    await seedRun("run-over", 9);
    const outcome = await appendRunResults(
      SCOPE,
      "run-over",
      batch("t-new"),
      NOW,
    );
    expect(outcome.kind).toBe("rowCapExceeded");
  });

  it("allows an idempotent update at the ceiling when it adds no row", async () => {
    await seedRun("run-at-cap", 3);
    await seedExistingResults("run-at-cap", "t-1", "t-2", "t-3");

    const outcome = await appendRunResults(
      SCOPE,
      "run-at-cap",
      batch("t-3"),
      NOW,
    );

    expect(outcome.kind).toBe("ok");
    expect(await readState("run-at-cap")).toEqual({
      totalTests: 3,
      persistedRows: 3,
    });
  });

  it("rejects a batch that crosses the ceiling under the run lock", async () => {
    await seedRun("run-cross", 2);
    await seedExistingResults("run-cross", "t-1", "t-2");

    const outcome = await appendRunResults(
      SCOPE,
      "run-cross",
      batch("t-3", "t-4"),
      NOW,
    );

    expect(outcome).toEqual({ kind: "rowCapExceeded", limit: 3, count: 4 });
    expect(await readState("run-cross")).toEqual({
      totalTests: 2,
      persistedRows: 2,
    });
  });

  it("serializes concurrent appends so the persisted row count stays capped", async () => {
    await seedRun("run-race", 2);
    await seedExistingResults("run-race", "t-1", "t-2");

    const outcomes = await Promise.all([
      appendRunResults(SCOPE, "run-race", batch("t-3"), NOW),
      appendRunResults(SCOPE, "run-race", batch("t-4"), NOW),
    ]);

    expect(outcomes.filter((outcome) => outcome.kind === "ok")).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => outcome.kind === "rowCapExceeded"),
    ).toHaveLength(1);
    expect(await readState("run-race")).toEqual({
      totalTests: 3,
      persistedRows: 3,
    });
  });
});

describe("openRun — planned-test prefill cap", () => {
  function openPayload(idempotencyKey: string, plannedCount: number) {
    return {
      idempotencyKey,
      run: {
        plannedTests: Array.from({ length: plannedCount }, (_, i) => ({
          testId: `planned-${i}`,
          title: `case ${i}`,
          file: "spec.ts",
        })),
      },
    } as OpenRunPayload;
  }

  it("refuses a fresh open whose planned set exceeds the ceiling — nothing persists", async () => {
    // The payload schema's MAX_PLANNED_TESTS (100k) sits above this instance's
    // 3-row ceiling: without the open-time gate, the prefill would persist
    // every planned row before the first append is ever checked.
    await expect(
      openRun(SCOPE, openPayload("cap-open", 4), NOW),
    ).rejects.toBeInstanceOf(RunRowCapExceededError);
    const rows = await h.db
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.idempotencyKey, "cap-open"));
    expect(rows).toEqual([]);
  });

  it("a duplicate open with an oversized planned set is exempt (that path prefills nothing)", async () => {
    await seedRun("run-dup-cap", 3);
    const out = await openRun(SCOPE, openPayload("run-dup-cap", 4), NOW);
    expect(out).toEqual({ runId: "run-dup-cap", duplicate: true });
    expect(await readState("run-dup-cap")).toEqual({
      totalTests: 3,
      persistedRows: 0,
    });
  });
});
