import { describe, it, expect, vi, beforeEach } from "vitest";

const { stub, idFromName, ns } = vi.hoisted(() => {
  const stub = {
    setState: vi.fn(async (_state: unknown, _key: string) => {}),
  };
  const idFromName = vi.fn((name: string) => `id:${name}`);
  const ns = {
    idFromName,
    get: vi.fn(() => stub),
  };
  return { stub, idFromName, ns };
});

vi.mock("cloudflare:workers", () => ({
  env: { SYNCED_STATE_SERVER: ns },
}));

import {
  broadcastRunUpdate,
  composeRunSummary,
  runRoomId,
  type RunProgressTest,
} from "../routes/api/progress";
import {
  makeTenantScope,
  makeTenantTestDb,
  selectResult,
} from "./helpers/test-db";

function changedTest(i: number): RunProgressTest {
  return {
    id: `tr-${i}`,
    testId: `t-${i}`,
    title: `Test ${i}`,
    projectName: null,
    file: "spec.ts",
    status: "passed",
    durationMs: 100,
    retryCount: 0,
    errorMessage: null,
    errorStack: null,
  };
}

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    status: "running",
    passed: 0,
    failed: 0,
    flaky: 0,
    skipped: 0,
    totalTests: 0,
    expectedTotalTests: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runRoomId", () => {
  it("composes a stable colon-delimited id from team/project/run slugs", () => {
    expect(
      runRoomId({ teamSlug: "acme", projectSlug: "web", runId: "run_abc" }),
    ).toBe("run:acme:web:run_abc");
  });
});

describe("composeRunSummary (DB-aware)", () => {
  it("returns null when the run row is missing", async () => {
    const { db, driver } = makeTenantTestDb();
    const scope = makeTenantScope({ db });
    driver.results.push(selectResult([]));

    const summary = await composeRunSummary(scope, "missing");
    expect(summary).toBeNull();
  });

  it("derives a RunSummary from the row when present", async () => {
    const { db, driver } = makeTenantTestDb();
    const scope = makeTenantScope({ db });
    driver.results.push(
      selectResult([runRow({ passed: 5, failed: 1, totalTests: 10 })]),
    );

    const summary = await composeRunSummary(scope, "run-1");
    expect(summary?.counts.passed).toBe(5);
    expect(summary?.counts.failed).toBe(1);
    expect(summary?.counts.queued).toBe(4);
  });

  it("filters by runId", async () => {
    const { db, driver } = makeTenantTestDb();
    const scope = makeTenantScope({ db });
    driver.results.push(selectResult([runRow({ id: "run-xyz" })]));

    await composeRunSummary(scope, "run-xyz");
    const q = driver.queries[0];
    expect(q.parameters).toContain("run-xyz");
  });
});

describe("broadcastRunUpdate", () => {
  it("addresses the realtime DO by runRoomId(team, project, run)", async () => {
    const { db, driver } = makeTenantTestDb();
    const scope = makeTenantScope({
      db,
      teamSlug: "acme",
      projectSlug: "web",
    });
    driver.results.push(selectResult([runRow({})]));

    await broadcastRunUpdate(scope, "run_abc", []);

    expect(idFromName).toHaveBeenCalledWith("run:acme:web:run_abc");
  });

  it("pushes only the summary key when changedTests is empty", async () => {
    const { db, driver } = makeTenantTestDb();
    const scope = makeTenantScope({ db });
    driver.results.push(selectResult([runRow({ passed: 3, totalTests: 5 })]));

    await broadcastRunUpdate(scope, "run-1", []);

    expect(stub.setState).toHaveBeenCalledTimes(1);
    const [, key] = stub.setState.mock.calls[0];
    expect(key).toBe("summary");
  });

  it("pushes summary AND tests-tail when changedTests is non-empty", async () => {
    const { db, driver } = makeTenantTestDb();
    const scope = makeTenantScope({ db });
    driver.results.push(selectResult([runRow({ passed: 1, totalTests: 5 })]));

    await broadcastRunUpdate(scope, "run-1", [changedTest(1), changedTest(2)]);

    expect(stub.setState).toHaveBeenCalledTimes(2);
    const keys = stub.setState.mock.calls.map(([, k]) => k);
    expect(keys).toContain("summary");
    expect(keys).toContain("tests-tail");

    const tailCall = stub.setState.mock.calls.find(
      ([, k]) => k === "tests-tail",
    );
    const tailPayload = tailCall![0] as { tests: RunProgressTest[] };
    expect(tailPayload.tests).toHaveLength(2);
    expect(tailPayload.tests[0].id).toBe("tr-1");
  });

  it("is a no-op when the run row is missing (nothing to broadcast)", async () => {
    const { db, driver } = makeTenantTestDb();
    const scope = makeTenantScope({ db });
    driver.results.push(selectResult([]));

    await broadcastRunUpdate(scope, "missing", [changedTest(1)]);

    expect(stub.setState).not.toHaveBeenCalled();
  });

  it("swallows errors from the realtime layer (ingest must not depend on it)", async () => {
    const { db, driver } = makeTenantTestDb();
    const scope = makeTenantScope({ db });
    driver.results.push(selectResult([runRow({})]));
    stub.setState.mockRejectedValueOnce(new Error("DO unreachable"));

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Must not throw.
    await expect(
      broadcastRunUpdate(scope, "run-1", []),
    ).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});
