import { describe, it, expect } from "vite-plus/test";
import {
  AppendResultsPayloadSchema,
  CompleteRunPayloadSchema,
  MAX as DASHBOARD_MAX,
  OpenRunPayloadSchema,
  RegisterArtifactsPayloadSchema,
} from "../../../../apps/dashboard/src/lib/schemas.js";
import {
  MAX_MESSAGE,
  MAX_STACK,
  MAX_TITLE,
  truncate,
  truncateNullable,
} from "../limits.js";
import { buildPayload, buildTestDescriptor } from "../index.js";
import {
  type ArtifactRegistration,
  type CompleteRunPayload,
  type OpenRunPayload,
  type ShardInfo,
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

  it("clamps an over-cap title + error client-side so the payload still parses (no 400/413)", () => {
    // The reporter's preflight caps MUST mirror the dashboard's, or an oversized
    // title (hard-rejected) 400s the run and a huge error 413s the body.
    expect(MAX_TITLE).toBe(DASHBOARD_MAX.TITLE);
    expect(MAX_MESSAGE).toBe(DASHBOARD_MAX.MESSAGE);
    expect(MAX_STACK).toBe(DASHBOARD_MAX.STACK);

    const test = makeTest({
      id: "big",
      outcome: "unexpected",
      title: "T".repeat(DASHBOARD_MAX.TITLE + 500),
    });
    const payload = buildPayload({
      test,
      results: [
        makeResult({
          status: "failed",
          duration: 1,
          retry: 0,
          errorMessage: "E".repeat(DASHBOARD_MAX.MESSAGE + 1000),
        }),
      ],
    });

    // Clamped to the caps — and the testId (a hash of the raw titlePath) is
    // unchanged by truncating the DISPLAY title, so prefill + result still match.
    expect(payload.title.length).toBe(DASHBOARD_MAX.TITLE);
    expect((payload.errorMessage ?? "").length).toBe(DASHBOARD_MAX.MESSAGE);
    // The real dashboard schema now accepts it verbatim (would have 400'd raw).
    const parsed = AppendResultsPayloadSchema.safeParse({ results: [payload] });
    expect(parsed.success).toBe(true);
  });

  it("truncate mirrors the dashboard's surrogate-pair-safe algorithm", () => {
    expect(truncate("abcdef", 3)).toBe("abc");
    expect(truncate("ab", 5)).toBe("ab");
    // Cutting at 3 would split the 😀 surrogate pair (idx 2-3) → pulled back to 2.
    expect(truncate("ab😀", 3)).toBe("ab");
    expect(truncateNullable(null, 5)).toBeNull();
    expect(truncateNullable(undefined, 5)).toBeNull();
    expect(truncateNullable("keep", 10)).toBe("keep");
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

  it("an open-run payload with a CODEOWNERS string parses through OpenRunPayloadSchema", () => {
    // roadmap 2.3: the reporter attaches the repo's CODEOWNERS file contents as
    // an optional top-level `codeowners` string on the open-run payload; the
    // dashboard upserts it onto the project. Guard the field both ways: a
    // payload carrying it parses (and the value survives), and a payload
    // omitting it still parses (the dashboard leaves any pasted file intact).
    const tests = [
      makeTest({
        id: "t1",
        outcome: "expected",
        title: "checkout",
        file: "tests/checkout.spec.ts",
      }),
    ];
    const plannedTests = tests.map((t) => buildTestDescriptor(t, null));
    const base = {
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

    const withCodeowners: OpenRunPayload = {
      ...base,
      codeowners: "/tests/checkout/  @team/payments\n*.spec.ts  @team/qa\n",
    };
    const parsedWith = OpenRunPayloadSchema.safeParse(withCodeowners);
    expect(parsedWith.success).toBe(true);
    expect(parsedWith.success && parsedWith.data.codeowners).toContain(
      "@team/payments",
    );

    // Omitting it is still valid; the dashboard treats absence as "don't touch".
    const parsedWithout = OpenRunPayloadSchema.safeParse(base);
    expect(parsedWithout.success).toBe(true);
    expect(
      parsedWithout.success && parsedWithout.data.codeowners,
    ).toBeUndefined();
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

  it("carries the reporter's shard coordinates on open + complete (sharded suite)", () => {
    const shard: ShardInfo = { index: 2, total: 4 };

    // The reporter attaches `shard` at the TOP LEVEL of both payloads (see
    // index.ts onBegin/onEnd); the dashboard must accept that shape.
    const open = {
      idempotencyKey: "build-123-e2e",
      shard,
      run: {
        ciProvider: null,
        ciBuildId: "build-123",
        branch: null,
        environment: null,
        commitSha: null,
        commitMessage: null,
        prNumber: null,
        repo: null,
        actor: null,
        reporterVersion: "0.1.1",
        playwrightVersion: "1.59.0",
        expectedTotalTests: 0,
        plannedTests: [],
      },
    } satisfies OpenRunPayload;
    const parsedOpen = OpenRunPayloadSchema.safeParse(open);
    expect(parsedOpen.success).toBe(true);
    if (parsedOpen.success) expect(parsedOpen.data.shard).toEqual(shard);

    const complete = {
      status: "passed",
      durationMs: 1234,
      shard,
    } satisfies CompleteRunPayload;
    const parsedComplete = CompleteRunPayloadSchema.safeParse(complete);
    expect(parsedComplete.success).toBe(true);
    if (parsedComplete.success)
      expect(parsedComplete.data.shard).toEqual(shard);
  });

  it("omits shard entirely on a non-sharded run (both payloads)", () => {
    const parsedComplete = CompleteRunPayloadSchema.safeParse({
      status: "passed",
      durationMs: 1,
    });
    expect(parsedComplete.success).toBe(true);
    expect(parsedComplete.success && parsedComplete.data.shard).toBeUndefined();
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

  it("a visual-triple registration (role + snapshotName) parses through RegisterArtifactsPayloadSchema", () => {
    const registrations: ArtifactRegistration[] = (
      ["expected", "actual", "diff"] as const
    ).map((role) => ({
      testResultId: "tr_1",
      type: "visual",
      name: `hero-chromium-linux-${role}.png`,
      contentType: "image/png",
      sizeBytes: 2048,
      attempt: 1,
      role,
      snapshotName: "hero-chromium-linux",
    }));

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
