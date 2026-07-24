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
import type { OpenRunPayload, TestResultInput } from "@/lib/schemas";

/**
 * Ingest-pipeline integration — split out of the former monolithic
 * `pg-integration.test.ts` (see docs/worklog/2026-07-11-split-pg-integration-tests.md).
 * This file owns the ingest domain: the REAL `appendRunResults` /results flush
 * (verify-ownership → FOR UPDATE lock → prev-status read → aggregate delta →
 * upsert/child-replace → catalog upsert → summary LAST), the jsonb
 * shard-expected-tests re-sum (`applyShardExpectedTests`), and the tests
 * catalog upsert (`buildTestCatalogUpsertStatements`) — all executed against
 * the real schema (pglite by default, real node-postgres under PG_TEST_URL).
 * See `./harness.ts` for the shared hoisted-mock boot dance.
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

// `appendRunResults` broadcasts to the `void/ws` rooms after its transaction
// commits; the realtime layer is out of scope here (same call as
// sharded-complete.test.ts) — swallow the publishes.
vi.mock("@/realtime/publish", () => ({
  broadcastRunRoom: () => Promise.resolve(),
  broadcastProjectRoom: () => Promise.resolve(),
}));

// `appendRunResults` reads the per-run test-result-row ceiling off `void/env`.
// Provide a generous cap so these pipeline tests never trip it (its enforcement
// is covered by `ingest-row-cap.test.ts`).
vi.mock("void/env", () => ({
  env: { WRIGHTFUL_MAX_TEST_RESULTS_PER_RUN: 500000 },
}));

const { resetTables } = await import("./harness");
const { runBatch } = await import("@/lib/db/batch");
const {
  appendRunResults,
  applyShardExpectedTests,
  buildRunInsertValues,
  buildTestCatalogUpsertStatements,
} = await import("@/lib/ingest");
const { makeTenantScope } = await import("@/lib/scope");
const { loadTestResultChildren } = await import("@/lib/test-result-children");
const { buildTestSearchWhere } = await import("@/lib/command-search");
const {
  runs,
  runShards,
  teams,
  testResults,
  testResultAttempts,
  testTags,
  testAnnotations,
  tests,
} = await import("../../../db/schema");
const { and, desc, eq } = await import("void/_db");

beforeAll(async () => {
  // `teams` isn't touched by any insert in this file, but `appendRunResults`
  // bumps the team's `lastActivityAt` as part of the /results flush — the
  // table just needs to EXIST (the update affects zero rows, which is fine).
  // `runShards` is only touched by `applyShardExpectedTests`' stale-row
  // cleanup in this file, but the DELETE references the table — it must exist.
  await resetTables(h.client, [runs, runShards, teams, testResults]);
});

afterAll(async () => {
  await h.client.close();
});

describe("ingest /results flush (appendRunResults)", () => {
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
    await resetTables(h.client, [
      testTags,
      testAnnotations,
      testResultAttempts,
      tests,
    ]);
    // appendRunResults upserts the tests catalog inside the same transaction;
    // its ON CONFLICT (projectId, testId) target needs the unique index. (The
    // later catalog-focused describe drops + recreates this table for itself.)
    await h.client.exec(
      'create unique index if not exists "tests_project_testId_idx" on "tests" ("projectId", "testId");',
    );
  });

  beforeEach(async () => {
    // Re-seed the parent run row: appendRunResults' owner probe, FOR UPDATE
    // lock, and summary UPDATE all key on it, and the counter assertions want
    // a known zero baseline.
    await h.db.delete(runs).where(eq(runs.id, RUN));
    await h.db.insert(runs).values({
      id: RUN,
      teamId: scope.teamId,
      projectId: scope.projectId,
      totalTests: 0,
      passed: 0,
      failed: 0,
      flaky: 0,
      skipped: 0,
      durationMs: 0,
      status: "running",
      origin: "ci",
      createdAt: T0,
      lastActivityAt: T0,
    });
    await h.db.delete(testResults).where(eq(testResults.runId, RUN));
    await h.db.delete(tests).where(eq(tests.projectId, scope.projectId));
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

  /**
   * Run the REAL /results pipeline — verify-ownership → FOR UPDATE lock →
   * prev-status read → delta → upsert/child-replace → catalog upsert →
   * summary LAST — via `appendRunResults` itself (no hand-rolled copy).
   */
  async function flush(results: TestResultInput[], now: number) {
    const outcome = await appendRunResults(scope, RUN, { results }, now);
    if (outcome.kind !== "ok") throw new Error(`flush failed: ${outcome.kind}`);
    return outcome;
  }

  /** The run row's aggregate counters + liveness signal. */
  async function readRunSummary() {
    const [row] = await h.db
      .select({
        totalTests: runs.totalTests,
        passed: runs.passed,
        failed: runs.failed,
        flaky: runs.flaky,
        skipped: runs.skipped,
        lastActivityAt: runs.lastActivityAt,
      })
      .from(runs)
      .where(eq(runs.id, RUN));
    return row!;
  }

  it("drives the full pipeline: persists rows + summary delta, and a serial re-flush nets a ZERO delta", async () => {
    const batch = [
      makeResult({
        testId: "e2e-pass",
        clientKey: "ck-pass",
        status: "passed",
        durationMs: 25,
        attempts: [{ attempt: 0, status: "passed", durationMs: 25 }],
      }),
      makeResult({
        testId: "e2e-fail",
        clientKey: "ck-fail",
        status: "failed",
        durationMs: 40,
        errorMessage: "boom",
      }),
    ];

    const first = await flush(batch, T1);

    // Persisted result rows…
    const rows = await h.db
      .select()
      .from(testResults)
      .where(eq(testResults.runId, RUN));
    const byTestId = new Map(rows.map((r) => [r.testId, r]));
    expect(byTestId.get("e2e-pass")).toMatchObject({
      status: "passed",
      durationMs: 25,
      createdAt: T1,
      updatedAt: T1,
    });
    expect(byTestId.get("e2e-fail")).toMatchObject({
      status: "failed",
      errorMessage: "boom",
    });
    // …the clientKey→id mapping points at those rows (the reporter's artifact
    // PUTs hang off these ids)…
    expect(first.mapping).toEqual([
      { clientKey: "ck-pass", testResultId: byTestId.get("e2e-pass")!.id },
      { clientKey: "ck-fail", testResultId: byTestId.get("e2e-fail")!.id },
    ]);
    // …the attempt child rows landed…
    const attempts = await h.db
      .select()
      .from(testResultAttempts)
      .where(eq(testResultAttempts.testResultId, byTestId.get("e2e-pass")!.id));
    expect(attempts).toHaveLength(1);
    // …and the tests catalog was upserted in the SAME flush (the old
    // hand-rolled test copy omitted this statement entirely).
    const catalog = await h.db
      .select()
      .from(tests)
      .where(eq(tests.projectId, scope.projectId));
    expect(catalog.map((c) => c.testId).sort()).toEqual([
      "e2e-fail",
      "e2e-pass",
    ]);

    // The aggregate delta applied under the run-row lock: 2 fresh tests.
    expect(await readRunSummary()).toEqual({
      totalTests: 2,
      passed: 1,
      failed: 1,
      flaky: 0,
      skipped: 0,
      lastActivityAt: T1,
    });

    // SERIAL RE-FLUSH of the same batch (a reporter retry once the first
    // committed): the prev-status read under the lock sees the committed
    // statuses, every bucket transition is a no-op → ZERO delta, so the
    // counters hold (no double-count) and the ids stay stable (the mapping
    // resolves the existing rows, not phantom fresh ULIDs). Only the liveness
    // signal advances (the no-delta branch's activity bump). This is the
    // serial equivalent of the FOR UPDATE lock's guarantee; true concurrency
    // needs the real-pg CI leg.
    const second = await flush(batch, T1 + 30);
    expect(second.mapping).toEqual(first.mapping);
    expect(await readRunSummary()).toEqual({
      totalTests: 2,
      passed: 1,
      failed: 1,
      flaky: 0,
      skipped: 0,
      lastActivityAt: T1 + 30,
    });
  });

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

    const { mapping } = await flush(
      [
        makeResult({
          clientKey: "ck-t1",
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
    // The id was resolved UNDER the run-row lock to the existing row — not a
    // phantom fresh ULID the ON CONFLICT DO UPDATE would have discarded.
    expect(mapping).toEqual([
      { clientKey: "ck-t1", testResultId: "tr-prefill" },
    ]);

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
    // A genuinely new testId bumps totalTests AND its status bucket.
    expect(await readRunSummary()).toMatchObject({
      totalTests: 1,
      failed: 1,
      passed: 0,
    });
  });

  it("persists per-attempt stdout/stderr — and loadTestResultChildren (the get_test_result path) reads them back", async () => {
    // The reporter joins Playwright's stdout/stderr chunks per attempt; the
    // dashboard writes them to the two new text columns and surfaces them via
    // loadTestResultChildren (which loadMcpTestResultDetail passes straight
    // through to the `get_test_result` tool). Prove both the persist and the
    // read-back against real Postgres, per attempt, distinct across retries.
    await flush(
      [
        makeResult({
          testId: "t-logs",
          status: "flaky",
          durationMs: 40,
          retryCount: 1,
          attempts: [
            {
              attempt: 0,
              status: "failed",
              durationMs: 10,
              errorMessage: "boom",
              stdout: "attempt 0 stdout\n",
              stderr: "attempt 0 stderr\n",
            },
            {
              attempt: 1,
              status: "passed",
              durationMs: 30,
              // A quiet retry: no stdout captured → column stays null.
              stderr: "attempt 1 stderr\n",
            },
          ],
        }),
      ],
      T1,
    );

    const [row] = await h.db
      .select()
      .from(testResults)
      .where(and(eq(testResults.runId, RUN), eq(testResults.testId, "t-logs")));
    const testResultId = row!.id;

    // Raw column read: the two attempts persisted their logs distinctly.
    const rawAttempts = await h.db
      .select()
      .from(testResultAttempts)
      .where(eq(testResultAttempts.testResultId, testResultId))
      .orderBy(testResultAttempts.attempt);
    expect(rawAttempts).toHaveLength(2);
    expect(rawAttempts[0]?.stdout).toBe("attempt 0 stdout\n");
    expect(rawAttempts[0]?.stderr).toBe("attempt 0 stderr\n");
    expect(rawAttempts[1]?.stdout).toBeNull();
    expect(rawAttempts[1]?.stderr).toBe("attempt 1 stderr\n");

    // MCP-surfacing read: loadTestResultChildren carries stdout/stderr per
    // attempt in attempt order — exactly what get_test_result returns.
    const { attempts } = await loadTestResultChildren(scope, testResultId);
    expect(attempts.map((a) => a.attempt)).toEqual([0, 1]);
    expect(attempts[0]?.stdout).toBe("attempt 0 stdout\n");
    expect(attempts[0]?.stderr).toBe("attempt 0 stderr\n");
    expect(attempts[1]?.stdout).toBeNull();
    expect(attempts[1]?.stderr).toBe("attempt 1 stderr\n");
  });

  it("re-flushing a prefilled result nets a ZERO aggregate delta (idempotent counters under serial replay)", async () => {
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
    // +1 passed; totalTests unchanged (prev status defined by the prefill row —
    // the seeded run baseline is 0, so it STAYS 0).
    await flush([result], T1);
    expect(await readRunSummary()).toMatchObject({
      totalTests: 0,
      passed: 1,
      lastActivityAt: T1,
    });
    // Serial replay (a reporter retry once the first committed): the locked
    // prev-status read now sees 'passed' → same bucket → the delta nets to
    // zero, so the counters hold; the no-delta branch still bumps the liveness
    // signal (activityBumpStatement), so lastActivityAt advances. This is the
    // serial-equivalent of the FOR UPDATE lock's guarantee; true concurrency
    // needs the real-pg CI leg.
    await flush([result], T1 + 10);
    expect(await readRunSummary()).toEqual({
      totalTests: 0,
      passed: 1,
      failed: 0,
      flaky: 0,
      skipped: 0,
      lastActivityAt: T1 + 10,
    });
  });
});

describe("sharded expected-total merge (applyShardExpectedTests jsonb re-sum)", () => {
  // Executes the EXACT production UPDATE (`jsonb_set` merge + `jsonb_each_text`
  // re-sum) against the real schema — hand-written jsonb SQL the mocked
  // ingest-pipeline lane can't vouch for. pglite locally; real node-postgres
  // under PG_TEST_URL in CI. The `runs` table comes from the file's top-level
  // beforeAll; rows here are isolated by their own tenant scope.
  const scope = makeTenantScope({
    teamId: "t-shardsum",
    projectId: "p-shardsum",
    teamSlug: "shardsum",
    projectSlug: "shardsum",
  });
  const T = 1_700_000_000;

  function openerPayload(over: Partial<OpenRunPayload> = {}): OpenRunPayload {
    return {
      idempotencyKey: "shard-key",
      run: {
        plannedTests: [
          { testId: "s1-a", title: "a", file: "spec.ts" },
          { testId: "s1-b", title: "b", file: "spec.ts" },
        ],
        expectedTotalTests: 2,
      },
      shard: { index: 1, total: 3 },
      ...over,
    } as OpenRunPayload;
  }

  async function readRun(id: string) {
    const rows = await h.db
      .select({
        expectedTotalTests: runs.expectedTotalTests,
        shardExpectedTests: runs.shardExpectedTests,
        expectedShards: runs.expectedShards,
        lastActivityAt: runs.lastActivityAt,
      })
      .from(runs)
      .where(eq(runs.id, id));
    return rows[0];
  }

  it("merges each later shard's count and re-derives the exact suite total", async () => {
    await h.db
      .insert(runs)
      .values(buildRunInsertValues("run-shardsum", scope, openerPayload(), T));
    // Opener's slice only, seeded by the insert values.
    expect(await readRun("run-shardsum")).toMatchObject({
      expectedTotalTests: 2,
      shardExpectedTests: { "1": 2 },
    });

    await applyShardExpectedTests(
      scope,
      "run-shardsum",
      { index: 2, total: 3 },
      3,
      T + 1,
    );
    expect(await readRun("run-shardsum")).toMatchObject({
      expectedTotalTests: 5,
      shardExpectedTests: { "1": 2, "2": 3 },
    });

    await applyShardExpectedTests(
      scope,
      "run-shardsum",
      { index: 3, total: 3 },
      4,
      T + 2,
    );
    expect(await readRun("run-shardsum")).toMatchObject({
      expectedTotalTests: 9,
      shardExpectedTests: { "1": 2, "2": 3, "3": 4 },
      lastActivityAt: T + 2,
    });
  });

  it("a retried shard open REPLACES its count — a shrunken re-run can LOWER the total", async () => {
    // CI re-ran shard 2 with one test fewer; keying `jsonb_set` on the shard
    // index must replace (not add), and the exact re-sum must go DOWN — a
    // `greatest`-style merge would show phantom pending tests forever.
    await applyShardExpectedTests(
      scope,
      "run-shardsum",
      { index: 2, total: 3 },
      1,
      T + 3,
    );
    expect(await readRun("run-shardsum")).toMatchObject({
      expectedTotalTests: 7,
      shardExpectedTests: { "1": 2, "2": 1, "3": 4 },
    });
  });

  it("starts the map from '{}' for a legacy opener and backfills expectedShards", async () => {
    // Mixed-version fleet: the opener predates shard-aware opens (no map, no
    // expectedShards). A later shard's merge must coalesce the null map — its
    // sum covers only shard-aware opens (the UI clamps the display with
    // max(expected, totalTests, buckets)) — and backfill expectedShards.
    const legacy = buildRunInsertValues(
      "run-legacyopener",
      scope,
      openerPayload({ idempotencyKey: "legacy-key", shard: undefined }),
      T,
    );
    await h.db.insert(runs).values(legacy);
    expect(await readRun("run-legacyopener")).toMatchObject({
      expectedTotalTests: 2,
      shardExpectedTests: null,
      expectedShards: null,
    });

    await applyShardExpectedTests(
      scope,
      "run-legacyopener",
      { index: 2, total: 3 },
      3,
      T + 1,
    );
    expect(await readRun("run-legacyopener")).toMatchObject({
      expectedTotalTests: 3,
      shardExpectedTests: { "2": 3 },
      expectedShards: 3,
    });
  });

  it("is tenant-scoped: a foreign scope's write does not touch the run", async () => {
    const foreign = makeTenantScope({
      teamId: "t-other",
      projectId: "p-other",
      teamSlug: "other",
      projectSlug: "other",
    });
    const before = await readRun("run-shardsum");
    await applyShardExpectedTests(
      foreign,
      "run-shardsum",
      { index: 9, total: 9 },
      999,
      T + 9,
    );
    expect(await readRun("run-shardsum")).toEqual(before);
  });

  it("a terminal re-run with a CHANGED total resets the map, replaces expectedShards, and drops stale shard rows", async () => {
    // Deterministic CI re-run reusing the idempotency key after the shard
    // count changed (3 → 2): the stored map/total and the previous run's
    // completion rows describe dead configuration — kept, they would 409
    // every /complete (`invalidShard`) or finalize against the wrong count.
    const rerun = buildRunInsertValues(
      "run-reshard",
      scope,
      openerPayload({ idempotencyKey: "reshard-key" }),
      T,
    );
    await h.db
      .insert(runs)
      .values({ ...rerun, status: "failed", completedAt: T + 100 });
    await h.db.insert(runShards).values(
      [1, 2, 3].map((i) => ({
        id: `rs-stale-${i}`,
        projectId: scope.projectId,
        runId: "run-reshard",
        shardIndex: i,
        shardTotal: 3,
        status: "failed",
        durationMs: 5,
        completedAt: T + 100,
        createdAt: T,
      })),
    );

    await applyShardExpectedTests(
      scope,
      "run-reshard",
      { index: 1, total: 2 },
      4,
      T + 200,
    );

    expect(await readRun("run-reshard")).toMatchObject({
      expectedShards: 2,
      shardExpectedTests: { "1": 4 },
      expectedTotalTests: 4,
    });
    const staleRows = await h.db
      .select({ shardIndex: runShards.shardIndex })
      .from(runShards)
      .where(
        and(
          eq(runShards.projectId, scope.projectId),
          eq(runShards.runId, "run-reshard"),
        ),
      );
    expect(staleRows).toEqual([]);
  });

  it("a terminal re-run with the SAME total also resets the map, drops the completion rows, and re-arms the run", async () => {
    // The most common CI re-run: same shard matrix, same idempotency key. The
    // previous run's completion rows carry the SAME shardTotal, so a
    // total-keyed delete would keep them and the re-run's first /complete
    // would find a full count and finalize against dead sibling results. The
    // reset latches on the terminal status instead, and the same UPDATE
    // re-arms the run (status='running', completedAt=null) so the latch fires
    // exactly once under racing sibling opens.
    const rerun = buildRunInsertValues(
      "run-samereshard",
      scope,
      openerPayload({ idempotencyKey: "samereshard-key" }),
      T,
    );
    await h.db
      .insert(runs)
      .values({ ...rerun, status: "failed", completedAt: T + 100 });
    await h.db.insert(runShards).values(
      [1, 2, 3].map((i) => ({
        id: `rs-same-${i}`,
        projectId: scope.projectId,
        runId: "run-samereshard",
        shardIndex: i,
        shardTotal: 3,
        status: "failed",
        durationMs: 5,
        completedAt: T + 100,
        createdAt: T,
      })),
    );

    await applyShardExpectedTests(
      scope,
      "run-samereshard",
      { index: 2, total: 3 },
      5,
      T + 200,
    );

    expect(await readRun("run-samereshard")).toMatchObject({
      expectedShards: 3,
      shardExpectedTests: { "2": 5 },
      expectedTotalTests: 5,
    });
    const rearmed = await h.db
      .select({ status: runs.status, completedAt: runs.completedAt })
      .from(runs)
      .where(eq(runs.id, "run-samereshard"));
    expect(rearmed[0]).toEqual({ status: "running", completedAt: null });
    const staleRows = await h.db
      .select({ shardIndex: runShards.shardIndex })
      .from(runShards)
      .where(
        and(
          eq(runShards.projectId, scope.projectId),
          eq(runShards.runId, "run-samereshard"),
        ),
      );
    expect(staleRows).toEqual([]);
  });

  it("a MID-FLIGHT open with a different total keeps the stored total (coalesce, no reset)", async () => {
    // status='running': a misconfigured sibling must not rewrite the
    // authoritative total mid-flight — /complete's `invalidShard` guard is
    // the surface that reports the mismatch.
    const midflight = buildRunInsertValues(
      "run-midflight",
      scope,
      openerPayload({ idempotencyKey: "midflight-key" }),
      T,
    );
    await h.db.insert(runs).values(midflight);

    await applyShardExpectedTests(
      scope,
      "run-midflight",
      { index: 2, total: 5 },
      3,
      T + 1,
    );

    expect(await readRun("run-midflight")).toMatchObject({
      expectedShards: 3,
      shardExpectedTests: { "1": 2, "2": 3 },
      expectedTotalTests: 5,
    });
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
    await resetTables(h.client, [tests]);
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
