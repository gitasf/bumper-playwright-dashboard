import { describe, expect, it } from "vite-plus/test";
import {
  AppendResultsPayloadSchema,
  MAX as DASHBOARD_MAX,
  MAX_PLANNED_TESTS as DASHBOARD_MAX_PLANNED_TESTS,
  MAX_RESULTS_PER_BATCH as DASHBOARD_MAX_RESULTS_PER_BATCH,
  OpenRunPayloadSchema,
  SUPPORTED_VERSIONS,
  TestAttemptSchema,
  WRIGHTFUL_VERSION_HEADER as DASHBOARD_VERSION_HEADER,
} from "../../../../apps/dashboard/src/lib/schemas.js";
import {
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_NAME_FIELD_LENGTH,
  MAX_SHORT_FIELD_LENGTH,
} from "../ci.js";
import { MAX_CODEOWNERS_BYTES } from "../codeowners-file.js";
import { MAX_PLANNED_TESTS, MAX_RESULTS_PER_BATCH } from "../limits.js";
import { buildPayload, buildTestDescriptor } from "../index.js";
import {
  PROTOCOL_VERSION,
  WRIGHTFUL_VERSION_HEADER as REPORTER_VERSION_HEADER,
} from "../types.js";
import { makeResult, makeTest } from "./fixtures.js";

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

// Per-attempt stdout/stderr capture: the live `buildPayload` reads Playwright's
// `TestResult.stdout`/`stderr` (Array<string|Buffer>) off each attempt, decodes
// + joins + truncates them, and the dashboard's `TestAttemptSchema` accepts the
// result. These assert the capture happens on the REAL reporter path (not just
// the seeder builder) and survives the wire parse — the console.log-reaches-MCP
// contract end to end.
describe("reporter ↔ dashboard captured stdout/stderr", () => {
  it("buildPayload joins mixed string + Buffer stdout/stderr chunks per attempt", () => {
    const test = makeTest({ id: "t1", outcome: "expected", title: "logs" });
    const payload = buildPayload({
      test,
      results: [
        makeResult({
          status: "passed",
          duration: 5,
          retry: 0,
          stdout: ["hello ", Buffer.from("world\n", "utf8")],
          stderr: [Buffer.from("deprecation ", "utf8"), "warning\n"],
        }),
      ],
    });

    expect(payload.attempts[0]?.stdout).toBe("hello world\n");
    expect(payload.attempts[0]?.stderr).toBe("deprecation warning\n");

    const parsed = AppendResultsPayloadSchema.safeParse({ results: [payload] });
    expect(parsed.success).toBe(true);
    // The value survives the schema transform verbatim (under the cap).
    expect(parsed.success && parsed.data.results[0]?.attempts[0]?.stdout).toBe(
      "hello world\n",
    );
  });

  it("emits null stdout/stderr for an attempt that wrote nothing", () => {
    const test = makeTest({ id: "t1", outcome: "expected", title: "quiet" });
    const payload = buildPayload({
      test,
      results: [makeResult({ status: "passed", duration: 1, retry: 0 })],
    });
    expect(payload.attempts[0]?.stdout).toBeNull();
    expect(payload.attempts[0]?.stderr).toBeNull();
  });

  it("clamps an over-cap stdout stream to MAX.MESSAGE so it can't 413 the batch", () => {
    const test = makeTest({ id: "t1", outcome: "expected", title: "chatty" });
    const payload = buildPayload({
      test,
      results: [
        makeResult({
          status: "passed",
          duration: 1,
          retry: 0,
          stdout: ["L".repeat(DASHBOARD_MAX.MESSAGE + 5000)],
        }),
      ],
    });
    expect((payload.attempts[0]?.stdout ?? "").length).toBe(
      DASHBOARD_MAX.MESSAGE,
    );
    const parsed = AppendResultsPayloadSchema.safeParse({ results: [payload] });
    expect(parsed.success).toBe(true);
  });

  it("keeps per-attempt stdout distinct across a flaky test's attempts", () => {
    const test = makeTest({
      id: "t1",
      outcome: "flaky",
      title: "recovers",
      retries: 1,
    });
    const payload = buildPayload({
      test,
      results: [
        makeResult({
          status: "failed",
          duration: 30,
          retry: 0,
          errorMessage: "first try",
          stdout: ["attempt 0 log\n"],
        }),
        makeResult({
          status: "passed",
          duration: 20,
          retry: 1,
          stdout: ["attempt 1 log\n"],
        }),
      ],
    });
    expect(payload.attempts[0]?.stdout).toBe("attempt 0 log\n");
    expect(payload.attempts[1]?.stdout).toBe("attempt 1 log\n");
  });
});

// The shape/enum/version checks above guard the wire STRUCTURE, but the
// reporter's two numeric preflight caps — the idempotency-key length and the
// CODEOWNERS byte size — are hand-mirrored from the dashboard's `MAX` table and
// escaped the canary entirely. A dashboard cap tightening the reporter didn't
// track would emit an over-long value the live server 400s on (a failed open
// loses the whole run, non-retryably). Pin each === its dashboard source.
describe("reporter ↔ dashboard preflight caps", () => {
  it("the reporter's idempotency-key cap equals the dashboard's MAX.ID", () => {
    expect(MAX_IDEMPOTENCY_KEY_LENGTH).toBe(DASHBOARD_MAX.ID);
  });

  it("the reporter's CODEOWNERS byte cap equals the dashboard's MAX.CODEOWNERS", () => {
    expect(MAX_CODEOWNERS_BYTES).toBe(DASHBOARD_MAX.CODEOWNERS);
  });

  it("the reporter's CI string-field clamps equal the dashboard's MAX.SHORT / MAX.NAME", () => {
    // ci.ts clamps commitSha/branch/repo/actor before emitting so an oversized
    // env/payload value can't 400 the (reject-on-oversize) open-run call.
    expect(MAX_SHORT_FIELD_LENGTH).toBe(DASHBOARD_MAX.SHORT);
    expect(MAX_NAME_FIELD_LENGTH).toBe(DASHBOARD_MAX.NAME);
  });

  it("the reporter's batch + planned-test array caps equal the dashboard's", () => {
    expect(MAX_RESULTS_PER_BATCH).toBe(DASHBOARD_MAX_RESULTS_PER_BATCH);
    expect(MAX_PLANNED_TESTS).toBe(DASHBOARD_MAX_PLANNED_TESTS);
  });
});
