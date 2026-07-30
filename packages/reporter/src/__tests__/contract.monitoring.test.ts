import { describe, expect, it } from "vite-plus/test";
import {
  AppendResultsPayloadSchema,
  OpenRunPayloadSchema,
} from "../../../../apps/dashboard/src/lib/schemas.js";
import {
  buildOpenRunPayload,
  buildResult,
  buildTestDescriptor,
} from "../index.js";
import { makeTest } from "./fixtures.js";

// Synthetic-monitoring provenance (run.origin + run.monitorId) is a v3
// addition the reporter must emit for a containerized monitor run. These
// assertions are the canary for the new fields: a hand-built synthetic
// open-run payload and the builder's synthetic output both have to parse
// through the dashboard's OpenRunPayloadSchema, and the dashboard must still
// default a normal (origin-less) run to "ci".
describe("reporter ↔ dashboard synthetic-monitoring contract", () => {
  it("a synthetic open-run payload (origin + monitorId) parses through OpenRunPayloadSchema", () => {
    const tests = [
      makeTest({
        id: "t1",
        outcome: "expected",
        title: "homepage loads",
        file: "check.spec.ts",
      }),
    ];
    const plannedTests = tests.map((t) => buildTestDescriptor(t, null));

    const openPayload = {
      // The container sets WRIGHTFUL_IDEMPOTENCY_KEY = monitorExecutions.id, so
      // the opened run is addressable by (projectId, idempotencyKey).
      idempotencyKey: "01EXEC0000000000000000000",
      run: {
        ciProvider: null,
        ciBuildId: null,
        branch: null,
        environment: null,
        commitSha: null,
        commitMessage: null,
        prNumber: null,
        repo: null,
        actor: null,
        reporterVersion: "0.1.1",
        playwrightVersion: "1.59.0",
        expectedTotalTests: plannedTests.length,
        plannedTests,
        origin: "synthetic" as const,
        monitorId: "01MON00000000000000000000",
      },
    };

    const parsed = OpenRunPayloadSchema.safeParse(openPayload);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.run.origin).toBe("synthetic");
    expect(parsed.success && parsed.data.run.monitorId).toBe(
      "01MON00000000000000000000",
    );
  });

  it("buildOpenRunPayload threads origin + monitorId onto the run object", () => {
    const open = buildOpenRunPayload(
      {
        idempotencyKey: "01EXEC0000000000000000000",
        reporterVersion: "0.1.0",
        playwrightVersion: "1.59.1",
        origin: "synthetic",
        monitorId: "01MON00000000000000000000",
      },
      [{ testId: "t1", title: "a", file: "check.spec.ts", projectName: null }],
    );

    expect(open.run.origin).toBe("synthetic");
    expect(open.run.monitorId).toBe("01MON00000000000000000000");

    const parsed = OpenRunPayloadSchema.safeParse(open);
    expect(parsed.success).toBe(true);
  });

  it("buildOpenRunPayload omits the provenance fields on a normal CI run", () => {
    const open = buildOpenRunPayload(
      {
        idempotencyKey: "ci-build-123",
        reporterVersion: "0.1.0",
        playwrightVersion: "1.59.1",
      },
      [{ testId: "t1", title: "a", file: "a.spec.ts", projectName: null }],
    );

    // A standard CI run leaves both fields off the wire entirely; the
    // dashboard defaults `origin` to "ci" server-side. Parsing must still
    // succeed and `monitorId` must remain absent.
    expect("origin" in open.run).toBe(false);
    expect("monitorId" in open.run).toBe(false);

    const parsed = OpenRunPayloadSchema.safeParse(open);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.run.origin).toBeUndefined();
  });
});

// The plain-data builders (payload.ts) are the third producer of the v3 wire
// shape — fed by the local history seeder (apps/dashboard/scripts/seed),
// which has only synthetic data and no Playwright runtime. Before they
// existed, the seeder hand-assembled the payloads as an untested copy that had
// already drifted (it omitted projectName/workerIndex). These assertions make
// the seeder's producer a first-class member of the canary: builder output is
// parsed through the same dashboard Zod schemas, so a new required wire field
// that the builder fails to emit goes red here rather than at the live server.
describe("seeder payload builders ↔ dashboard wire contract", () => {
  it("buildResult output parses through AppendResultsPayloadSchema", () => {
    const result = buildResult(
      {
        testId: "tests/auth/signin.spec.ts|logs in",
        title: "logs in",
        file: "tests/auth/signin.spec.ts",
        projectName: null,
        status: "flaky",
        durationMs: 80,
      },
      [
        { attempt: 0, status: "failed", durationMs: 50, errorMessage: "boom" },
        { attempt: 1, status: "passed", durationMs: 30 },
      ],
    );

    const parsed = AppendResultsPayloadSchema.safeParse({ results: [result] });
    expect(parsed.success).toBe(true);
  });

  it("buildResult emits the full TestResult key set the dashboard declares", () => {
    const result = buildResult(
      {
        testId: "t1",
        title: "t",
        file: "a.spec.ts",
        projectName: null,
        status: "passed",
        durationMs: 12,
      },
      [{ attempt: 0, status: "passed", durationMs: 12 }],
    );

    const resultElement = AppendResultsPayloadSchema.shape.results.element;
    const expected = Object.keys(resultElement.shape).sort();
    const emitted = Object.keys(result).sort();
    // Same exact-key-set guard the reporter's buildPayload gets — catches a
    // one-sided field add on either the schema or the builder.
    expect(emitted).toEqual(expected);
  });

  it("buildOpenRunPayload output parses through OpenRunPayloadSchema", () => {
    const open = buildOpenRunPayload(
      {
        idempotencyKey: "seed-1-0-0-main",
        ciProvider: "github",
        branch: "main",
        reporterVersion: "0.1.0",
        playwrightVersion: "1.59.1",
      },
      [
        { testId: "t1", title: "a", file: "a.spec.ts", projectName: null },
        { testId: "t2", title: "b", file: "b.spec.ts", projectName: null },
      ],
    );

    const parsed = OpenRunPayloadSchema.safeParse(open);
    expect(parsed.success).toBe(true);
  });

  it("buildOpenRunPayload's plannedTests element matches the schema's key set", () => {
    const open = buildOpenRunPayload(
      {
        idempotencyKey: "seed-1-0-0-main",
        reporterVersion: "0.1.0",
        playwrightVersion: "1.59.1",
      },
      [{ testId: "t1", title: "a", file: "a.spec.ts", projectName: null }],
    );

    const plannedArray =
      OpenRunPayloadSchema.shape.run.shape.plannedTests.unwrap();
    const expected = Object.keys(plannedArray.element.shape).sort();
    const emitted = Object.keys(open.run.plannedTests[0] as object).sort();
    expect(emitted).toEqual(expected);
  });
});
