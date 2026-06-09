import { describe, it, expect } from "vite-plus/test";
import {
  AppendResultsPayloadSchema,
  AppendResultsResponseSchema,
  CompleteRunPayloadSchema,
  OpenRunPayloadSchema,
  OpenRunResponseSchema,
  RegisterArtifactsPayloadSchema,
  RegisterArtifactsResponseSchema,
  SUPPORTED_VERSIONS,
  TestAttemptSchema,
  WRIGHTFUL_VERSION_HEADER as DASHBOARD_VERSION_HEADER,
} from "../../../../apps/dashboard/src/lib/schemas.js";
import {
  buildOpenRunPayload,
  buildPayload,
  buildResult,
  buildTestDescriptor,
} from "../index.js";
import {
  PROTOCOL_VERSION,
  WRIGHTFUL_VERSION_HEADER as REPORTER_VERSION_HEADER,
  type AppendResultsResponse,
  type ArtifactRegistration,
  type OpenRunResponse,
  type RegisterArtifactsResponse,
  type TestResultPayload,
} from "../types.js";
import { makeResult, makeTest } from "./fixtures.js";

// This test is the canary against silent drift between the reporter's
// emitted payload shape (packages/reporter/src/index.ts) and the dashboard's
// Zod wire schemas (apps/dashboard/src/lib/schemas.ts). It builds
// payloads with the reporter's real `buildPayload` and parses them through
// the dashboard's schemas. Any divergence on either side breaks this test.

describe("reporter ↔ dashboard wire contract", () => {
  it("buildPayload output for a passing test parses through AppendResultsPayloadSchema", () => {
    const test = makeTest({ id: "t1", outcome: "expected", title: "passes" });
    const payload = buildPayload({
      test,
      results: [makeResult({ status: "passed", duration: 12, retry: 0 })],
    });

    const parsed = AppendResultsPayloadSchema.safeParse({ results: [payload] });
    expect(parsed.success).toBe(true);
  });

  it("buildPayload output for a failed test parses through AppendResultsPayloadSchema", () => {
    const test = makeTest({ id: "t1", outcome: "unexpected", title: "fails" });
    const payload = buildPayload({
      test,
      results: [
        makeResult({
          status: "failed",
          duration: 50,
          retry: 0,
          errorMessage: "boom",
        }),
      ],
    });

    const parsed = AppendResultsPayloadSchema.safeParse({ results: [payload] });
    expect(parsed.success).toBe(true);
  });

  it("buildPayload output for a flaky test parses with all attempts present", () => {
    const test = makeTest({
      id: "t1",
      outcome: "flaky",
      title: "recovers on retry",
      retries: 2,
    });
    const payload = buildPayload({
      test,
      results: [
        makeResult({
          status: "failed",
          duration: 30,
          retry: 0,
          errorMessage: "first try",
        }),
        makeResult({ status: "passed", duration: 25, retry: 1 }),
      ],
    });

    expect(payload.status).toBe("flaky");
    expect(payload.retryCount).toBe(1);
    expect(payload.attempts).toHaveLength(2);

    const parsed = AppendResultsPayloadSchema.safeParse({ results: [payload] });
    expect(parsed.success).toBe(true);
  });

  it("buildPayload output for a timed-out test maps Playwright 'timedOut' → wire 'timedout'", () => {
    const test = makeTest({ id: "t1", outcome: "unexpected", title: "slow" });
    const payload = buildPayload({
      test,
      results: [makeResult({ status: "timedOut", duration: 30000, retry: 0 })],
    });

    expect(payload.status).toBe("timedout");
    expect(payload.attempts[0]?.status).toBe("timedout");

    const parsed = AppendResultsPayloadSchema.safeParse({ results: [payload] });
    expect(parsed.success).toBe(true);
  });

  it("buildPayload output for a skipped test parses cleanly", () => {
    const test = makeTest({ id: "t1", outcome: "skipped", title: "skipped" });
    const payload = buildPayload({
      test,
      results: [makeResult({ status: "skipped", duration: 0, retry: 0 })],
    });

    const parsed = AppendResultsPayloadSchema.safeParse({ results: [payload] });
    expect(parsed.success).toBe(true);
  });

  it("batched payload (many tests) parses through AppendResultsPayloadSchema", () => {
    const payloads: TestResultPayload[] = [];
    for (let i = 0; i < 50; i++) {
      const test = makeTest({
        id: `t${i}`,
        outcome: i % 7 === 0 ? "unexpected" : "expected",
        title: `case ${i}`,
        file: `suite-${i % 5}.spec.ts`,
      });
      payloads.push(
        buildPayload({
          test,
          results: [
            makeResult({
              status: i % 7 === 0 ? "failed" : "passed",
              duration: i,
              retry: 0,
              errorMessage: i % 7 === 0 ? "x" : undefined,
            }),
          ],
        }),
      );
    }

    const parsed = AppendResultsPayloadSchema.safeParse({ results: payloads });
    expect(parsed.success).toBe(true);
  });

  it("planned-test descriptor parses through OpenRunPayloadSchema", () => {
    const tests = [
      makeTest({
        id: "t1",
        outcome: "expected",
        title: "a",
        file: "a.spec.ts",
      }),
      makeTest({
        id: "t2",
        outcome: "expected",
        title: "b",
        file: "b.spec.ts",
        projectName: "firefox",
      }),
    ];
    const plannedTests = tests.map((t) => buildTestDescriptor(t, null));

    const openPayload = {
      idempotencyKey: "deterministic-key",
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
      },
    };

    const parsed = OpenRunPayloadSchema.safeParse(openPayload);
    expect(parsed.success).toBe(true);
  });

  it("CompleteRunPayloadSchema accepts all reporter-emitted statuses", () => {
    for (const status of [
      "passed",
      "failed",
      "timedout",
      "interrupted",
    ] as const) {
      const parsed = CompleteRunPayloadSchema.safeParse({
        status,
        durationMs: 1234,
      });
      expect(parsed.success).toBe(true);
    }
  });

  it("RegisterArtifactsPayloadSchema accepts the reporter's ArtifactRegistration shape", () => {
    const registrations: ArtifactRegistration[] = [
      {
        testResultId: "tr_1",
        type: "trace",
        name: "trace.zip",
        contentType: "application/zip",
        sizeBytes: 1024,
        attempt: 0,
      },
      {
        testResultId: "tr_2",
        type: "screenshot",
        name: "screenshot.png",
        contentType: "image/png",
        sizeBytes: 4096,
        attempt: 1,
      },
    ];

    const parsed = RegisterArtifactsPayloadSchema.safeParse({
      runId: "run_abc",
      artifacts: registrations,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an empty results batch (matches reporter's ≥1 invariant)", () => {
    const parsed = AppendResultsPayloadSchema.safeParse({ results: [] });
    expect(parsed.success).toBe(false);
  });

  it("rejects a malformed status (catches accidental enum drift)", () => {
    const parsed = AppendResultsPayloadSchema.safeParse({
      results: [
        {
          testId: "t1",
          title: "x",
          file: "a.spec.ts",
          status: "succeeded", // not a valid wire status
          durationMs: 0,
          retryCount: 0,
          attempts: [{ attempt: 0, status: "passed", durationMs: 0 }],
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });
});

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

// The response side (server → reporter) is the other half of the wire
// contract: the reporter reads `runId`/`runUrl`, the `clientKey → testResultId`
// mapping, and the artifact uploads off these JSON bodies (see client.ts). The
// fields are typed as the reporter's `*Response` interfaces here, so a
// reporter-side rename is a compile error; the values are then parsed through
// the dashboard's `*ResponseSchema`, so a dashboard-side rename is a runtime
// failure. This mirrors the request-side canary for the previously-unguarded
// response shapes.
describe("dashboard ↔ reporter response contract", () => {
  it("POST /api/runs response parses through OpenRunResponseSchema", () => {
    // Shape returned by routes/api/runs/index.ts.
    const response: OpenRunResponse = {
      runId: "run_abc",
      runUrl: "/t/acme/p/web/runs/run_abc",
    };
    const parsed = OpenRunResponseSchema.safeParse(response);
    expect(parsed.success).toBe(true);
  });

  it("OpenRunResponseSchema tolerates the handler's extra `duplicate` field", () => {
    // The idempotent-replay path adds `duplicate: true`; the reporter ignores
    // it. Passthrough keeps it from being flagged as drift.
    const parsed = OpenRunResponseSchema.safeParse({
      runId: "run_abc",
      runUrl: "/t/acme/p/web/runs/run_abc",
      duplicate: true,
    });
    expect(parsed.success).toBe(true);
  });

  it("OpenRunResponseSchema accepts a missing runUrl (reporter treats it as null)", () => {
    const parsed = OpenRunResponseSchema.safeParse({ runId: "run_abc" });
    expect(parsed.success).toBe(true);
  });

  it("OpenRunResponseSchema rejects a missing runId (the field the reporter requires)", () => {
    const parsed = OpenRunResponseSchema.safeParse({
      runUrl: "/t/acme/p/web/runs/run_abc",
    });
    expect(parsed.success).toBe(false);
  });

  it("POST /api/runs/:id/results response parses through AppendResultsResponseSchema", () => {
    // Shape returned by routes/api/runs/[id]/results.ts ({ results: mapping }).
    const response: AppendResultsResponse = {
      results: [
        { clientKey: "ck_1", testResultId: "tr_1" },
        { clientKey: "ck_2", testResultId: "tr_2" },
      ],
    };
    const parsed = AppendResultsResponseSchema.safeParse(response);
    expect(parsed.success).toBe(true);
    // The reporter keys artifact uploads off this exact pair — guard the names.
    expect(parsed.success && parsed.data.results[0]).toEqual({
      clientKey: "ck_1",
      testResultId: "tr_1",
    });
  });

  it("AppendResultsResponseSchema accepts an empty mapping (no client-keyed results)", () => {
    const parsed = AppendResultsResponseSchema.safeParse({ results: [] });
    expect(parsed.success).toBe(true);
  });

  it("AppendResultsResponseSchema rejects a mapping with a renamed key (catches drift)", () => {
    const parsed = AppendResultsResponseSchema.safeParse({
      results: [{ clientKey: "ck_1", testResultIdentifier: "tr_1" }],
    });
    expect(parsed.success).toBe(false);
  });

  it("POST /api/artifacts/register response parses through RegisterArtifactsResponseSchema", () => {
    // Shape returned by routes/api/artifacts/register.ts ({ uploads }).
    const response: RegisterArtifactsResponse = {
      uploads: [
        {
          artifactId: "art_1",
          uploadUrl: "/api/artifacts/art_1/upload",
          r2Key: "t/team/p/proj/runs/run/tr/art_1/trace.zip",
        },
      ],
    };
    const parsed = RegisterArtifactsResponseSchema.safeParse(response);
    expect(parsed.success).toBe(true);
  });

  it("RegisterArtifactsResponseSchema rejects an upload missing uploadUrl (the field the reporter PUTs to)", () => {
    const parsed = RegisterArtifactsResponseSchema.safeParse({
      uploads: [{ artifactId: "art_1", r2Key: "k" }],
    });
    expect(parsed.success).toBe(false);
  });
});

// The protocol version is a third hand-maintained copy of the contract: the
// reporter stamps `PROTOCOL_VERSION` on every ingest request (client.ts), and
// the dashboard independently maintains the `SUPPORTED_VERSIONS` accept-set it
// 409s against (api-auth.ts → schemas.ts). Nothing but discipline kept the two
// literals in step. These assertions make the existing cross-package canary
// the enforcement point: bump the reporter's version without the dashboard
// learning to accept it (or vice versa) and the build goes red.
describe("reporter ↔ dashboard protocol version", () => {
  it("the reporter's PROTOCOL_VERSION is in the dashboard's SUPPORTED_VERSIONS", () => {
    expect(SUPPORTED_VERSIONS.has(String(PROTOCOL_VERSION))).toBe(true);
  });

  it("both packages name the version header identically", () => {
    expect(REPORTER_VERSION_HEADER).toBe(DASHBOARD_VERSION_HEADER);
  });
});

// The request-side parse tests above prove the reporter's payloads are
// *accepted* by the dashboard schemas, but acceptance is one-directional: a
// new optional field added to the dashboard schema (and never emitted) or a
// field the reporter emits that the schema strips would both parse clean and
// drift silently. This block closes that gap by comparing the key SETS — the
// schema's declared keys vs. the keys the reporter actually emits — so a
// one-sided field shows up as an exact-equality failure here.
describe("reporter ↔ dashboard wire shape (structural equivalence)", () => {
  const schemaKeys = (shape: Record<string, unknown>): string[] =>
    Object.keys(shape).sort();

  it("emitted TestResultPayload keys match the dashboard's TestResultSchema", () => {
    const test = makeTest({ id: "t1", outcome: "expected", title: "passes" });
    const payload = buildPayload({
      test,
      results: [makeResult({ status: "passed", duration: 12, retry: 0 })],
    });

    // The TestResult shape lives inside AppendResultsPayloadSchema.results.
    // The reporter emits every field (nullable ones as `null`), so the key
    // sets must match exactly — a one-sided add on either side fails here.
    const resultElement = AppendResultsPayloadSchema.shape.results.element;
    const expected = schemaKeys(resultElement.shape);
    const emitted = Object.keys(payload).sort();

    expect(emitted).toEqual(expected);
  });

  it("emitted TestAttemptPayload keys match the dashboard's TestAttemptSchema", () => {
    const test = makeTest({ id: "t1", outcome: "unexpected", title: "fails" });
    const payload = buildPayload({
      test,
      results: [
        makeResult({
          status: "failed",
          duration: 50,
          retry: 0,
          errorMessage: "boom",
        }),
      ],
    });

    const expected = schemaKeys(TestAttemptSchema.shape);
    const attempt = payload.attempts[0];
    expect(attempt).toBeDefined();
    const emitted = Object.keys(attempt as object).sort();

    expect(emitted).toEqual(expected);
  });

  it("planned-test descriptor keys match the dashboard's run.plannedTests element", () => {
    const descriptor = buildTestDescriptor(
      makeTest({
        id: "t1",
        outcome: "expected",
        title: "a",
        file: "a.spec.ts",
      }),
      null,
    );

    // `plannedTests` is `z.array(...).default([])` — unwrap the default to
    // reach the array, then its element shape.
    const plannedArray =
      OpenRunPayloadSchema.shape.run.shape.plannedTests.unwrap();
    const expected = schemaKeys(plannedArray.element.shape);
    const emitted = Object.keys(descriptor).sort();

    expect(emitted).toEqual(expected);
  });
});
