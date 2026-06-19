import { describe, it, expect } from "vite-plus/test";
import { buildChangedTests } from "@/lib/ingest";
import type { TestResultInput } from "@/lib/schemas";

function input(overrides: Partial<TestResultInput>): TestResultInput {
  return {
    testId: "t-1",
    title: "test 1",
    file: "spec.ts",
    status: "passed",
    durationMs: 100,
    retryCount: 0,
    tags: [],
    annotations: [],
    attempts: [
      {
        attempt: 0,
        status: "passed",
        durationMs: 100,
        errorMessage: null,
        errorStack: null,
      },
    ],
    ...overrides,
  };
}

describe("buildChangedTests", () => {
  it("maps each result to its assigned testResultId", () => {
    const results = [input({ testId: "t-1" }), input({ testId: "t-2" })];
    const ids = new Map([
      ["t-1", "tr-aaa"],
      ["t-2", "tr-bbb"],
    ]);
    const out = buildChangedTests(results, ids);
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe("tr-aaa");
    expect(out[1].id).toBe("tr-bbb");
  });

  it("passes through testId, title, file, status, durationMs, retryCount", () => {
    const out = buildChangedTests(
      [
        input({
          testId: "t-1",
          title: "my test",
          file: "a/b.spec.ts",
          status: "failed",
          durationMs: 1234,
          retryCount: 2,
        }),
      ],
      new Map([["t-1", "tr-1"]]),
    );
    expect(out[0]).toMatchObject({
      testId: "t-1",
      title: "my test",
      file: "a/b.spec.ts",
      status: "failed",
      durationMs: 1234,
      retryCount: 2,
    });
  });

  it("normalises an absent projectName to null (not undefined)", () => {
    const out = buildChangedTests([input({})], new Map([["t-1", "tr-1"]]));
    expect(out[0].projectName).toBeNull();
  });

  it("preserves a non-null projectName (error text is intentionally NOT carried on the live wire row — loaded from D1 on the test-detail page)", () => {
    const out = buildChangedTests(
      [input({ projectName: "chromium", errorMessage: "boom" })],
      new Map([["t-1", "tr-1"]]),
    );
    expect(out[0].projectName).toBe("chromium");
    // RunProgressTest no longer has errorMessage/errorStack — assert they're gone.
    expect("errorMessage" in out[0]!).toBe(false);
    expect("errorStack" in out[0]!).toBe(false);
  });

  it("returns an empty array for an empty batch (no DB lookup)", () => {
    expect(buildChangedTests([], new Map())).toEqual([]);
  });

  it("preserves order of input results", () => {
    const results = [
      input({ testId: "t-1" }),
      input({ testId: "t-2" }),
      input({ testId: "t-3" }),
    ];
    const ids = new Map([
      ["t-1", "tr-1"],
      ["t-2", "tr-2"],
      ["t-3", "tr-3"],
    ]);
    expect(buildChangedTests(results, ids).map((r) => r.testId)).toEqual([
      "t-1",
      "t-2",
      "t-3",
    ]);
  });
});
