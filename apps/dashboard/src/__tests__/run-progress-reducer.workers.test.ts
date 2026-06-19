import { describe, it, expect } from "vite-plus/test";
import {
  applyRunProgressEvent,
  currentSummary,
  seedRunProgressState,
  type RunProgressState,
} from "@/realtime/run-progress";
import type { RunProgressEvent, RunProgressTest } from "@/realtime/events";

function test(overrides: Partial<RunProgressTest> = {}): RunProgressTest {
  return {
    id: "tr-1",
    testId: "t-1",
    title: "test 1",
    file: "spec.ts",
    projectName: null,
    status: "passed",
    durationMs: 100,
    retryCount: 0,
    ...overrides,
  };
}

function summary(
  overrides: Partial<RunProgressEvent["summary"]> = {},
): RunProgressEvent["summary"] {
  return {
    totalTests: 1,
    passed: 1,
    failed: 0,
    flaky: 0,
    skipped: 0,
    durationMs: 100,
    status: "running",
    completedAt: null,
    ...overrides,
  };
}

function progress(
  changedTests: RunProgressTest[],
  summaryOverrides: Partial<RunProgressEvent["summary"]> = {},
): RunProgressEvent {
  return {
    type: "progress",
    changedTests,
    summary: summary(summaryOverrides),
  };
}

describe("seedRunProgressState", () => {
  it("returns an empty accumulator and null summary with no args", () => {
    expect(seedRunProgressState()).toEqual({ byId: {}, summary: null });
  });

  it("seeds byId keyed by each row's id", () => {
    const state = seedRunProgressState([
      test({ id: "tr-1" }),
      test({ id: "tr-2", testId: "t-2" }),
    ]);
    expect(Object.keys(state.byId)).toEqual(["tr-1", "tr-2"]);
    expect(state.byId["tr-2"].testId).toBe("t-2");
  });

  it("last-writer-wins on duplicate ids in the seed", () => {
    const state = seedRunProgressState([
      test({ id: "tr-1", status: "passed" }),
      test({ id: "tr-1", status: "failed" }),
    ]);
    expect(Object.keys(state.byId)).toEqual(["tr-1"]);
    expect(state.byId["tr-1"].status).toBe("failed");
  });

  it("carries through the initial summary", () => {
    const s = summary({ status: "completed", completedAt: 123 });
    const state = seedRunProgressState([], s);
    expect(state.summary).toEqual(s);
  });

  it("normalises undefined initial summary to null", () => {
    expect(seedRunProgressState([test()], undefined).summary).toBeNull();
  });
});

describe("applyRunProgressEvent", () => {
  it("ignores non-progress events and returns prev unchanged (same reference)", () => {
    const prev: RunProgressState = {
      byId: { "tr-1": test() },
      summary: summary(),
    };
    // A foreign envelope shape that isn't a progress event.
    const notProgress = { type: "other", changedTests: [], summary: null };
    const next = applyRunProgressEvent(
      prev,
      notProgress as unknown as RunProgressEvent,
    );
    expect(next).toBe(prev);
  });

  it("merges changedTests by id into a cloned accumulator", () => {
    const prev: RunProgressState = {
      byId: { "tr-1": test({ id: "tr-1", status: "passed" }) },
      summary: null,
    };
    const next = applyRunProgressEvent(
      prev,
      progress([test({ id: "tr-2", testId: "t-2", status: "failed" })]),
    );
    expect(Object.keys(next.byId).sort()).toEqual(["tr-1", "tr-2"]);
    expect(next.byId["tr-2"].status).toBe("failed");
    // does not mutate prev
    expect(Object.keys(prev.byId)).toEqual(["tr-1"]);
    expect(next.byId).not.toBe(prev.byId);
  });

  it("last-writer-wins when an event re-reports an existing id (retry)", () => {
    const prev: RunProgressState = {
      byId: { "tr-1": test({ id: "tr-1", status: "failed", retryCount: 0 }) },
      summary: null,
    };
    const next = applyRunProgressEvent(
      prev,
      progress([test({ id: "tr-1", status: "passed", retryCount: 1 })]),
    );
    expect(Object.keys(next.byId)).toEqual(["tr-1"]);
    expect(next.byId["tr-1"].status).toBe("passed");
    expect(next.byId["tr-1"].retryCount).toBe(1);
  });

  it("replaces (not merges) the summary on every progress event", () => {
    const prev: RunProgressState = {
      byId: {},
      summary: summary({ passed: 5, totalTests: 5 }),
    };
    const next = applyRunProgressEvent(
      prev,
      progress([test()], { passed: 0, failed: 1, totalTests: 1 }),
    );
    expect(next.summary).toEqual(
      summary({ passed: 0, failed: 1, totalTests: 1 }),
    );
  });

  it("advances the summary but keeps byId referentially stable on an empty-changedTests event", () => {
    const prev: RunProgressState = {
      byId: { "tr-1": test() },
      summary: summary({ status: "running" }),
    };
    const next = applyRunProgressEvent(
      prev,
      progress([], { status: "completed", completedAt: 999 }),
    );
    expect(next.byId).toBe(prev.byId);
    expect(next.summary).toEqual(
      summary({ status: "completed", completedAt: 999 }),
    );
  });

  it("seeds from empty then folds a sequence of events", () => {
    let state = seedRunProgressState();
    state = applyRunProgressEvent(state, progress([test({ id: "tr-1" })]));
    state = applyRunProgressEvent(
      state,
      progress([test({ id: "tr-2", testId: "t-2" })]),
    );
    state = applyRunProgressEvent(
      state,
      progress([test({ id: "tr-1", status: "failed" })]),
    );
    expect(Object.keys(state.byId).sort()).toEqual(["tr-1", "tr-2"]);
    expect(state.byId["tr-1"].status).toBe("failed");
  });
});

describe("currentSummary", () => {
  const fallback = summary({ passed: 3, totalTests: 3 });

  it("returns the live summary once state.summary is populated", () => {
    const live = summary({ passed: 0, failed: 1, totalTests: 1 });
    const state: RunProgressState = { byId: {}, summary: live };
    expect(currentSummary(state, fallback)).toBe(live);
  });

  it("falls back to the SSR summary when state.summary is null", () => {
    const state: RunProgressState = { byId: {}, summary: null };
    expect(currentSummary(state, fallback)).toBe(fallback);
  });

  it("tracks the live summary as events advance it (seed -> event)", () => {
    // The run-detail page always seeds from `run.*`, so the live value is
    // returned from first paint and keeps tracking subsequent events.
    let state = seedRunProgressState([], fallback);
    expect(currentSummary(state, fallback)).toEqual(fallback);
    state = applyRunProgressEvent(
      state,
      progress([test()], { passed: 4, failed: 1, totalTests: 5 }),
    );
    expect(currentSummary(state, fallback)).toEqual(
      summary({ passed: 4, failed: 1, totalTests: 5 }),
    );
  });
});
