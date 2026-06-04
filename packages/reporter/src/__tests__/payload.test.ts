import { describe, it, expect } from "vite-plus/test";
import {
  buildAttempt,
  buildCompleteRunPayload,
  buildOpenRunPayload,
  buildResult,
  type RunMeta,
} from "../payload.js";

const META: RunMeta = {
  idempotencyKey: "seed-1-0-0-main",
  reporterVersion: "0.1.0",
  playwrightVersion: "1.59.1",
};

describe("buildAttempt", () => {
  it("fills omitted error fields with null", () => {
    expect(
      buildAttempt({ attempt: 0, status: "passed", durationMs: 12 }),
    ).toEqual({
      attempt: 0,
      status: "passed",
      durationMs: 12,
      errorMessage: null,
      errorStack: null,
    });
  });

  it("preserves supplied error fields", () => {
    expect(
      buildAttempt({
        attempt: 1,
        status: "failed",
        durationMs: 30,
        errorMessage: "boom",
        errorStack: "at x:1:1",
      }),
    ).toEqual({
      attempt: 1,
      status: "failed",
      durationMs: 30,
      errorMessage: "boom",
      errorStack: "at x:1:1",
    });
  });
});

describe("buildResult", () => {
  it("emits projectName and workerIndex — the fields the hand-built seeder dropped", () => {
    const result = buildResult(
      {
        testId: "a.spec.ts|t",
        title: "t",
        file: "a.spec.ts",
        projectName: null,
        status: "passed",
        durationMs: 12,
      },
      [{ attempt: 0, status: "passed", durationMs: 12 }],
    );

    // The two drift fields are present, with the reporter's defaults.
    expect(result.projectName).toBe(null);
    expect(result.workerIndex).toBe(0);
  });

  it("defaults clientKey to testId and derives retryCount from attempts", () => {
    const result = buildResult(
      {
        testId: "t1",
        title: "flaky",
        file: "a.spec.ts",
        projectName: null,
        status: "flaky",
        durationMs: 50,
      },
      [
        { attempt: 0, status: "failed", durationMs: 30, errorMessage: "x" },
        { attempt: 1, status: "passed", durationMs: 20 },
      ],
    );

    expect(result.clientKey).toBe("t1");
    expect(result.retryCount).toBe(1);
    // Each attempt is normalised — even the passing retry carries null errors.
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[1]).toEqual({
      attempt: 1,
      status: "passed",
      durationMs: 20,
      errorMessage: null,
      errorStack: null,
    });
  });

  it("honors an explicit clientKey, workerIndex and retryCount", () => {
    const result = buildResult(
      {
        testId: "t1",
        title: "t",
        file: "a.spec.ts",
        projectName: "firefox",
        status: "passed",
        durationMs: 10,
        clientKey: "ck",
        workerIndex: 3,
        retryCount: 0,
      },
      [{ attempt: 0, status: "passed", durationMs: 10 }],
    );

    expect(result.clientKey).toBe("ck");
    expect(result.workerIndex).toBe(3);
    expect(result.projectName).toBe("firefox");
  });

  it("rejects an undefined projectName (the silent-drift hazard) but allows null", () => {
    const fields = {
      testId: "t1",
      title: "t",
      file: "a.spec.ts",
      status: "passed" as const,
      durationMs: 10,
    };
    expect(() =>
      // @ts-expect-error projectName is required at runtime
      buildResult(fields, [{ attempt: 0, status: "passed", durationMs: 10 }]),
    ).toThrow(/projectName/);
    expect(() =>
      buildResult({ ...fields, projectName: null }, [
        { attempt: 0, status: "passed", durationMs: 10 },
      ]),
    ).not.toThrow();
  });

  it("rejects an empty attempts list (mirrors the wire's ≥1 invariant)", () => {
    expect(() =>
      buildResult(
        {
          testId: "t1",
          title: "t",
          file: "a.spec.ts",
          projectName: null,
          status: "passed",
          durationMs: 0,
        },
        [],
      ),
    ).toThrow(/attempt/);
  });

  it("rejects a blank testId", () => {
    expect(() =>
      buildResult(
        {
          testId: "",
          title: "t",
          file: "a.spec.ts",
          projectName: null,
          status: "passed",
          durationMs: 0,
        },
        [{ attempt: 0, status: "passed", durationMs: 0 }],
      ),
    ).toThrow(/testId/);
  });
});

describe("buildOpenRunPayload", () => {
  it("derives expectedTotalTests from the planned list and nulls omitted meta", () => {
    const payload = buildOpenRunPayload(META, [
      { testId: "t1", title: "a", file: "a.spec.ts", projectName: null },
      { testId: "t2", title: "b", file: "b.spec.ts", projectName: "firefox" },
    ]);

    expect(payload.run.expectedTotalTests).toBe(2);
    expect(payload.run.ciProvider).toBe(null);
    expect(payload.run.prNumber).toBe(null);
    expect(payload.run.plannedTests[0]?.projectName).toBe(null);
  });

  it("rejects a planned test with an undefined projectName", () => {
    expect(() =>
      buildOpenRunPayload(META, [
        // @ts-expect-error projectName is required at runtime
        { testId: "t1", title: "a", file: "a.spec.ts" },
      ]),
    ).toThrow(/projectName/);
  });

  it("rejects a blank idempotencyKey", () => {
    expect(() =>
      buildOpenRunPayload({ ...META, idempotencyKey: "" }, []),
    ).toThrow(/idempotencyKey/);
  });
});

describe("buildCompleteRunPayload", () => {
  it("returns the terminal status and duration", () => {
    expect(buildCompleteRunPayload("passed", 1234)).toEqual({
      status: "passed",
      durationMs: 1234,
    });
  });
});
