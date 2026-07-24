import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vite-plus/test";
import { Batcher } from "../batcher.js";
import type { TestResultPayload } from "../types.js";

function makeResult(key: string): TestResultPayload {
  return {
    clientKey: key,
    testId: key,
    title: key,
    file: "a.ts",
    projectName: null,
    status: "passed",
    durationMs: 10,
    retryCount: 0,
    errorMessage: null,
    errorStack: null,
    workerIndex: 0,
    shardIndex: null,
    tags: [],
    annotations: [],
    attempts: [
      {
        attempt: 0,
        status: "passed",
        durationMs: 10,
        errorMessage: null,
        errorStack: null,
        stdout: null,
        stderr: null,
      },
    ],
  };
}

describe("Batcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("flushes when batch size is reached", async () => {
    const batches: TestResultPayload[][] = [];
    const b = new Batcher<TestResultPayload>({
      batchSize: 2,
      flushIntervalMs: 1000,
      flush: async (batch) => {
        batches.push(batch);
      },
      onFailure: () => {},
    });
    b.enqueue(makeResult("a"));
    expect(batches).toHaveLength(0);
    b.enqueue(makeResult("b"));
    await b.drain();
    expect(batches).toHaveLength(1);
    expect(batches[0].map((r) => r.clientKey)).toEqual(["a", "b"]);
  });

  it("flushes on timer when size is not reached", async () => {
    const batches: TestResultPayload[][] = [];
    const b = new Batcher<TestResultPayload>({
      batchSize: 10,
      flushIntervalMs: 500,
      flush: async (batch) => {
        batches.push(batch);
      },
      onFailure: () => {},
    });
    b.enqueue(makeResult("a"));
    expect(batches).toHaveLength(0);
    vi.advanceTimersByTime(500);
    await b.drain();
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
  });

  it("routes failed batches through onFailure instead of throwing", async () => {
    const failures: TestResultPayload[][] = [];
    const b = new Batcher<TestResultPayload>({
      batchSize: 1,
      flushIntervalMs: 100,
      flush: async () => {
        throw new Error("boom");
      },
      onFailure: (batch) => {
        failures.push(batch);
      },
    });
    b.enqueue(makeResult("a"));
    await b.drain();
    expect(failures).toHaveLength(1);
    expect(failures[0][0].clientKey).toBe("a");
  });

  it("drain triggers a pending timer-scheduled flush", async () => {
    const batches: TestResultPayload[][] = [];
    const b = new Batcher<TestResultPayload>({
      batchSize: 10,
      flushIntervalMs: 10_000,
      flush: async (batch) => {
        batches.push(batch);
      },
      onFailure: () => {},
    });
    b.enqueue(makeResult("a"));
    await b.drain();
    expect(batches).toHaveLength(1);
  });
});
