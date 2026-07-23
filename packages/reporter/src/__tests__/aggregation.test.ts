import { describe, it, expect } from "vite-plus/test";
import { isTestDone, buildPayload, buildTestDescriptor } from "../index.js";
import { makeTest, makeResult } from "./fixtures.js";

describe("isTestDone", () => {
  it("treats a passed attempt as done", () => {
    const t = makeTest({ retries: 2, outcome: "expected" });
    expect(
      isTestDone(t, makeResult({ status: "passed", duration: 10, retry: 0 })),
    ).toBe(true);
  });

  it("treats a skipped attempt as done", () => {
    const t = makeTest({ retries: 2, outcome: "skipped" });
    expect(
      isTestDone(t, makeResult({ status: "skipped", duration: 0, retry: 0 })),
    ).toBe(true);
  });

  it("treats an interrupted attempt as done", () => {
    const t = makeTest({ retries: 2, outcome: "unexpected" });
    expect(
      isTestDone(
        t,
        makeResult({ status: "interrupted", duration: 5, retry: 0 }),
      ),
    ).toBe(true);
  });

  it("waits for next attempt when failed with retries remaining", () => {
    const t = makeTest({ retries: 2, outcome: "unexpected" });
    expect(
      isTestDone(t, makeResult({ status: "failed", duration: 10, retry: 0 })),
    ).toBe(false);
    expect(
      isTestDone(t, makeResult({ status: "failed", duration: 10, retry: 1 })),
    ).toBe(false);
  });

  it("treats final failed attempt as done when retries exhausted", () => {
    const t = makeTest({ retries: 2, outcome: "unexpected" });
    expect(
      isTestDone(t, makeResult({ status: "failed", duration: 10, retry: 2 })),
    ).toBe(true);
  });

  it("single-run test (retries=0) is done on its only attempt", () => {
    const t = makeTest({ retries: 0, outcome: "expected" });
    expect(
      isTestDone(t, makeResult({ status: "passed", duration: 10, retry: 0 })),
    ).toBe(true);
  });
});

describe("buildPayload", () => {
  it("emits passed status with single attempt and retryCount=0", () => {
    const test = makeTest({ outcome: "expected" });
    const payload = buildPayload({
      test,
      results: [makeResult({ status: "passed", duration: 123, retry: 0 })],
    });
    expect(payload.status).toBe("passed");
    expect(payload.durationMs).toBe(123);
    expect(payload.retryCount).toBe(0);
    expect(payload.errorMessage).toBe(null);
  });

  it("aggregates flaky: failed-then-passed → one flaky row, summed duration", () => {
    const test = makeTest({ retries: 2, outcome: "flaky" });
    const payload = buildPayload({
      test,
      results: [
        makeResult({
          status: "failed",
          duration: 200,
          retry: 0,
          errorMessage: "boom",
        }),
        makeResult({ status: "passed", duration: 150, retry: 1 }),
      ],
    });
    expect(payload.status).toBe("flaky");
    expect(payload.durationMs).toBe(350);
    expect(payload.retryCount).toBe(1);
    // errorMessage comes from the failing attempt, not the final pass.
    expect(payload.errorMessage).toBe("boom");
  });

  it("exhausted retries → failed with last attempt's error", () => {
    const test = makeTest({ retries: 2, outcome: "unexpected" });
    const payload = buildPayload({
      test,
      results: [
        makeResult({
          status: "failed",
          duration: 100,
          retry: 0,
          errorMessage: "first",
        }),
        makeResult({
          status: "failed",
          duration: 100,
          retry: 1,
          errorMessage: "second",
        }),
        makeResult({
          status: "failed",
          duration: 100,
          retry: 2,
          errorMessage: "third",
        }),
      ],
    });
    expect(payload.status).toBe("failed");
    expect(payload.durationMs).toBe(300);
    expect(payload.retryCount).toBe(2);
    expect(payload.errorMessage).toBe("third");
  });

  it("maps timed-out unexpected to status=timedout", () => {
    const test = makeTest({ outcome: "unexpected" });
    const payload = buildPayload({
      test,
      results: [makeResult({ status: "timedOut", duration: 30000, retry: 0 })],
    });
    expect(payload.status).toBe("timedout");
  });

  it("maps skipped outcome to status=skipped", () => {
    const test = makeTest({ outcome: "skipped" });
    const payload = buildPayload({
      test,
      results: [makeResult({ status: "skipped", duration: 0, retry: 0 })],
    });
    expect(payload.status).toBe("skipped");
  });

  it("passes through tags and annotations", () => {
    const test = makeTest({
      outcome: "expected",
      tags: ["smoke", "critical"],
      annotations: [{ type: "issue", description: "X-123" }],
    });
    const payload = buildPayload({
      test,
      results: [makeResult({ status: "passed", duration: 10, retry: 0 })],
    });
    expect(payload.tags).toEqual(["smoke", "critical"]);
    expect(payload.annotations).toEqual([
      { type: "issue", description: "X-123" },
    ]);
  });

  it("clientKey matches testId (no :retry suffix)", () => {
    const test = makeTest({ outcome: "expected" });
    const payload = buildPayload({
      test,
      results: [makeResult({ status: "passed", duration: 10, retry: 0 })],
    });
    expect(payload.clientKey).toBe(payload.testId);
    expect(payload.clientKey).not.toMatch(/:/);
  });

  it("relativizes file path when rootDir is provided", () => {
    const test = makeTest({
      outcome: "expected",
      file: "/repo/packages/e2e/tests/demo.spec.ts",
    });
    const payload = buildPayload(
      {
        test,
        results: [makeResult({ status: "passed", duration: 1, retry: 0 })],
      },
      "/repo/packages/e2e",
    );
    expect(payload.file).toBe("tests/demo.spec.ts");
  });

  it("passes file through unchanged when rootDir is null", () => {
    const test = makeTest({
      outcome: "expected",
      file: "/abs/path/tests/demo.spec.ts",
    });
    const payload = buildPayload({
      test,
      results: [makeResult({ status: "passed", duration: 1, retry: 0 })],
    });
    expect(payload.file).toBe("/abs/path/tests/demo.spec.ts");
  });

  it("carries the shard index when running under --shard", () => {
    const test = makeTest({ outcome: "expected" });
    const payload = buildPayload(
      {
        test,
        results: [makeResult({ status: "passed", duration: 1, retry: 0 })],
      },
      null,
      2,
    );
    expect(payload.shardIndex).toBe(2);
  });

  it("emits shardIndex: null on a non-sharded run", () => {
    const test = makeTest({ outcome: "expected" });
    const payload = buildPayload({
      test,
      results: [makeResult({ status: "passed", duration: 1, retry: 0 })],
    });
    expect(payload.shardIndex).toBeNull();
  });

  it("emits one attempts[] entry per Playwright attempt with its own error", () => {
    const test = makeTest({ retries: 2, outcome: "unexpected" });
    const payload = buildPayload({
      test,
      results: [
        makeResult({
          status: "failed",
          duration: 100,
          retry: 0,
          errorMessage: "first boom",
        }),
        makeResult({
          status: "failed",
          duration: 120,
          retry: 1,
          errorMessage: "second boom",
        }),
        makeResult({
          status: "timedOut",
          duration: 5000,
          retry: 2,
          errorMessage: "timeout",
        }),
      ],
    });
    expect(payload.attempts).toHaveLength(3);
    expect(payload.attempts[0]).toMatchObject({
      attempt: 0,
      status: "failed",
      durationMs: 100,
      errorMessage: "first boom",
    });
    expect(payload.attempts[1]).toMatchObject({
      attempt: 1,
      status: "failed",
      errorMessage: "second boom",
    });
    // timedOut → timedout on the wire.
    expect(payload.attempts[2]).toMatchObject({
      attempt: 2,
      status: "timedout",
      errorMessage: "timeout",
    });
  });

  it("flaky test emits per-attempt statuses (fail, fail, pass)", () => {
    const test = makeTest({ retries: 2, outcome: "flaky" });
    const payload = buildPayload({
      test,
      results: [
        makeResult({
          status: "failed",
          duration: 100,
          retry: 0,
          errorMessage: "nope",
        }),
        makeResult({
          status: "failed",
          duration: 100,
          retry: 1,
          errorMessage: "still nope",
        }),
        makeResult({ status: "passed", duration: 80, retry: 2 }),
      ],
    });
    expect(payload.attempts.map((a) => a.status)).toEqual([
      "failed",
      "failed",
      "passed",
    ]);
    expect(payload.attempts[2].errorMessage).toBe(null);
  });

  it("single-attempt pass has one attempts entry with no error", () => {
    const test = makeTest({ outcome: "expected" });
    const payload = buildPayload({
      test,
      results: [makeResult({ status: "passed", duration: 50, retry: 0 })],
    });
    expect(payload.attempts).toEqual([
      {
        attempt: 0,
        status: "passed",
        durationMs: 50,
        errorMessage: null,
        errorStack: null,
        stdout: null,
        stderr: null,
      },
    ]);
  });
});

describe("buildTestDescriptor", () => {
  it("produces the same testId / file / title as buildPayload for the same test", () => {
    // Ensures the queue prefill at onBegin lands on exactly the row that
    // /results later UPSERTs — the server keys both by (runId, testId).
    const test = makeTest({
      outcome: "expected",
      title: "my test",
      file: "/repo/packages/e2e/tests/demo.spec.ts",
      projectName: "chromium",
    });
    const rootDir = "/repo/packages/e2e";
    const descriptor = buildTestDescriptor(test, rootDir);
    const payload = buildPayload(
      {
        test,
        results: [makeResult({ status: "passed", duration: 1, retry: 0 })],
      },
      rootDir,
    );
    expect(descriptor.testId).toBe(payload.testId);
    expect(descriptor.file).toBe(payload.file);
    expect(descriptor.title).toBe(payload.title);
    expect(descriptor.projectName).toBe(payload.projectName);
  });
});
