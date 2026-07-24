// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

const h = await vi.hoisted(async () => {
  const { buildHarness } = await import("./harness");
  return buildHarness();
});

vi.mock("void/db", async () => {
  const ops = await vi.importActual<Record<string, unknown>>("void/_db");
  return { ...ops, db: h.db };
});

const { resetTables } = await import("./harness");
const { loadMcpFlakyDiagnosis, loadMcpTestHistory } =
  await import("@/lib/mcp/diagnose");
const { makeTenantScope } = await import("@/lib/scope");
const { runs, testResultAttempts, testResults, tests } =
  await import("../../../db/schema");

const NOW = 1_800_000_000;
const scope = makeTenantScope({
  teamId: "team_mcp",
  projectId: "project_mcp",
  teamSlug: "acme",
  projectSlug: "web",
});

function run(id: string, createdAt: number, status = "failed") {
  return {
    id,
    teamId: scope.teamId,
    projectId: scope.projectId,
    totalTests: 2,
    passed: status === "passed" ? 2 : 0,
    failed: status === "passed" ? 0 : 1,
    flaky: 0,
    skipped: 0,
    durationMs: 1000,
    status,
    branch: "main",
    commitSha: `abcde${createdAt}`,
    prNumber: 55,
    createdAt,
    lastActivityAt: createdAt,
    completedAt: createdAt + 10,
    origin: "ci",
  };
}

function result(
  id: string,
  runId: string,
  testId: string,
  status: string,
  createdAt: number,
  errorMessage: string | null = null,
) {
  return {
    id,
    projectId: scope.projectId,
    runId,
    testId,
    title: testId === "test_login" ? "logs in" : "opens navigation",
    file:
      testId === "test_login"
        ? "tests/login.spec.ts"
        : "tests/navigation.spec.ts",
    projectName: "chromium",
    status,
    durationMs: status === "passed" ? 500 : 1500,
    retryCount: status === "flaky" ? 1 : 0,
    errorMessage,
    errorStack: errorMessage
      ? `${errorMessage}\n    at test.spec.ts:42:7`
      : null,
    workerIndex: 3,
    shardIndex: null,
    createdAt,
    updatedAt: createdAt,
  };
}

beforeAll(async () => {
  vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
  await resetTables(h.client, [runs, testResults, testResultAttempts, tests]);

  const bFlakyAt = NOW - 300;
  const aFlakyAt = NOW - 200;
  const latestAt = NOW - 100;
  await h.db.insert(runs).values([
    run("run_b_flaky", bFlakyAt),
    run("run_a_flaky", aFlakyAt),
    run("run_latest", latestAt, "passed"),
    {
      ...run("run_synthetic", NOW - 50),
      origin: "synthetic",
    },
  ]);
  const loginError =
    "\u001b[31mError: expect(page).toHaveURL(expected) failed after 30000ms\u001b[39m";
  const navError =
    "Error: expect(page).toHaveURL(expected) failed after 45000ms";
  await h.db
    .insert(testResults)
    .values([
      result(
        "result_b_flaky",
        "run_b_flaky",
        "test_navigation",
        "flaky",
        bFlakyAt,
        navError,
      ),
      result(
        "result_a_failed",
        "run_b_flaky",
        "test_login",
        "failed",
        bFlakyAt,
        loginError,
      ),
      result(
        "result_a_flaky",
        "run_a_flaky",
        "test_login",
        "flaky",
        aFlakyAt,
        loginError,
      ),
      result(
        "result_b_failed",
        "run_a_flaky",
        "test_navigation",
        "timedout",
        aFlakyAt,
        navError,
      ),
      result("result_a_passed", "run_latest", "test_login", "passed", latestAt),
      result(
        "result_b_passed",
        "run_latest",
        "test_navigation",
        "passed",
        latestAt,
      ),
      result(
        "result_synthetic_flake",
        "run_synthetic",
        "test_login",
        "flaky",
        NOW - 50,
        "Error: synthetic-only failure",
      ),
    ]);
  await h.db.insert(testResultAttempts).values([
    {
      id: "attempt_a_0",
      projectId: scope.projectId,
      testResultId: "result_a_flaky",
      attempt: 0,
      status: "failed",
      durationMs: 1000,
      errorMessage: loginError,
      createdAt: aFlakyAt,
    },
    {
      id: "attempt_a_1",
      projectId: scope.projectId,
      testResultId: "result_a_flaky",
      attempt: 1,
      status: "passed",
      durationMs: 500,
      createdAt: aFlakyAt,
    },
  ]);
  await h.db.insert(tests).values([
    {
      id: "catalog_login",
      projectId: scope.projectId,
      testId: "test_login",
      title: "logs in",
      file: "tests/login.spec.ts",
      firstSeenAt: bFlakyAt,
      lastSeenAt: latestAt,
    },
    {
      id: "catalog_navigation",
      projectId: scope.projectId,
      testId: "test_navigation",
      title: "opens navigation",
      file: "tests/navigation.spec.ts",
      firstSeenAt: bFlakyAt,
      lastSeenAt: latestAt,
    },
    {
      id: "catalog_other_project",
      projectId: "project_other",
      testId: "test_other_login",
      title: "logs in elsewhere",
      file: "tests/login.spec.ts",
      firstSeenAt: bFlakyAt,
      lastSeenAt: latestAt,
    },
  ]);
});

afterAll(async () => {
  vi.restoreAllMocks();
  await h.client.close();
});

describe("MCP flaky diagnosis Postgres queries", () => {
  it("returns numeric counters, signatures, representatives, co-failures, and current health", async () => {
    const diagnosis = await loadMcpFlakyDiagnosis(scope, {
      days: 14,
      branch: "main",
      limit: 2,
    });

    expect(diagnosis.totalFlakyTests).toBe(2);
    expect(diagnosis.currentHealth).toMatchObject({
      latestRunId: "run_latest",
      latestRunStatus: "passed",
      branch: "main",
    });
    const login = diagnosis.tests.find((test) => test.testId === "test_login");
    expect(login).toMatchObject({
      samples: 3,
      analyzedRows: 3,
      firstAttemptFailures: 2,
      retryPasses: 1,
      hardFailures: 1,
      passedCount: 1,
      flakeRatePct: 50,
      passedInLatestRun: true,
      latestStatus: "passed",
      distinctSignatures: 1,
      coFailureRunsAnalyzed: 1,
      representatives: {
        latestFlakyTestResultId: "result_a_flaky",
        latestHardFailTestResultId: "result_a_failed",
        latestPassedTestResultId: "result_a_passed",
      },
    });
    expect(typeof login?.samples).toBe("number");
    expect(login?.signatures).toContainEqual({
      signature: "expect(page).toHaveURL(expected) failed after <duration>",
      count: 2,
      correlatedTests: 1,
      representativeTestResultId: "result_a_flaky",
    });
    expect(login?.coFailures).toContainEqual({
      testId: "test_navigation",
      title: "opens navigation",
      sharedRuns: 1,
    });
  });

  it("resolves catalog search and returns the commit-to-attempt timeline", async () => {
    const history = await loadMcpTestHistory(scope, {
      selector: { kind: "query", value: "login" },
      days: 30,
      branch: "main",
      limit: 50,
    });

    expect(history.matchedTests).toEqual([
      {
        testId: "test_login",
        title: "logs in",
        file: "tests/login.spec.ts",
      },
    ]);
    expect(history.matchedTestsTruncated).toBe(false);
    expect(
      history.executions.map((execution) => execution.testResultId),
    ).toEqual(["result_a_passed", "result_a_flaky", "result_a_failed"]);
    const flaky = history.executions.find(
      (execution) => execution.testResultId === "result_a_flaky",
    );
    expect(flaky).toMatchObject({
      commit: `abcde${NOW - 200}`,
      branch: "main",
      prNumber: 55,
      status: "flaky",
      workerIndex: 3,
      shardIndex: null,
      errorSignature:
        "expect(page).toHaveURL(expected) failed after <duration>",
      attempts: [
        { attempt: 0, status: "failed", durationMs: 1000 },
        { attempt: 1, status: "passed", durationMs: 500 },
      ],
    });
  });
});
