import { describe, expect, it, vi } from "vitest";
// The seeder ingest loop is a `.mjs` script module (no `void/db` import, so it
// is fully unit-testable). It drives an injected client that satisfies the
// reporter's StreamClient surface; here we pass a recording fake to assert the
// open → chunked append → complete pipeline and the failure tally — the
// behaviour the local `--history` seed depends on.
import {
  chunk,
  DEFAULT_BATCH_SIZE,
  ingestRun,
  ingestRuns,
} from "../../scripts/seed/ingest-runs.mjs";

function makeRun(resultCount: number, completedAt = 1_700_000_000) {
  return {
    openPayload: { idempotencyKey: `k-${resultCount}` },
    resultsPayload: {
      results: Array.from({ length: resultCount }, (_, i) => ({ id: i })),
    },
    completePayload: { status: "passed", durationMs: 1234, completedAt },
  };
}

function makeClient() {
  const calls: {
    open: unknown[];
    append: Array<{ runId: string; results: unknown[] }>;
    complete: Array<{
      runId: string;
      status: string;
      durationMs: number;
      options?: { completedAt?: number };
    }>;
  } = { open: [], append: [], complete: [] };
  let n = 0;
  return {
    calls,
    openRun: vi.fn(async (payload: unknown) => {
      calls.open.push(payload);
      return { runId: `run_${++n}` };
    }),
    appendResults: vi.fn(async (runId: string, results: unknown[]) => {
      calls.append.push({ runId, results });
      return [];
    }),
    completeRun: vi.fn(
      async (
        runId: string,
        status: string,
        durationMs: number,
        options?: { completedAt?: number },
      ) => {
        calls.complete.push({ runId, status, durationMs, options });
      },
    ),
  };
}

describe("chunk", () => {
  it("splits into contiguous batches of at most size", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("returns one chunk when size exceeds length", () => {
    expect(chunk([1, 2], 50)).toEqual([[1, 2]]);
  });

  it("returns [] for an empty input", () => {
    expect(chunk([], 50)).toEqual([]);
  });

  it("rejects a non-positive size", () => {
    expect(() => chunk([1], 0)).toThrow(RangeError);
    expect(() => chunk([1], -1)).toThrow(RangeError);
  });
});

describe("ingestRun", () => {
  it("opens, appends results in batches, then completes — in order", async () => {
    const client = makeClient();
    await ingestRun(client, makeRun(120), { batchSize: 50 });

    expect(client.openRun).toHaveBeenCalledTimes(1);
    // 120 results / 50 → 3 batches of 50, 50, 20.
    expect(client.calls.append.map((a) => a.results.length)).toEqual([
      50, 50, 20,
    ]);
    // Every append targets the run id returned by openRun.
    expect(client.calls.append.every((a) => a.runId === "run_1")).toBe(true);
    expect(client.completeRun).toHaveBeenCalledTimes(1);
  });

  it("forwards the backdated completedAt so seeded history keeps its date", async () => {
    const client = makeClient();
    await ingestRun(client, makeRun(1, 1_600_000_000));

    expect(client.calls.complete[0]).toMatchObject({
      runId: "run_1",
      status: "passed",
      durationMs: 1234,
      options: { completedAt: 1_600_000_000 },
    });
  });

  it("defaults the batch size when not supplied", async () => {
    const client = makeClient();
    await ingestRun(client, makeRun(DEFAULT_BATCH_SIZE + 1));
    expect(client.calls.append.map((a) => a.results.length)).toEqual([
      DEFAULT_BATCH_SIZE,
      1,
    ]);
  });
});

describe("ingestRuns", () => {
  it("tallies completed runs across the batch", async () => {
    const client = makeClient();
    const result = await ingestRuns(client, [makeRun(1), makeRun(2)]);
    expect(result).toEqual({ completed: 2, failed: 0 });
    expect(client.openRun).toHaveBeenCalledTimes(2);
  });

  it("isolates a failing run and continues, reporting it via onError", async () => {
    const client = makeClient();
    client.openRun.mockRejectedValueOnce(new Error("boom"));
    const onError = vi.fn();

    const result = await ingestRuns(client, [makeRun(1), makeRun(1)], {
      onError,
    });

    expect(result).toEqual({ completed: 1, failed: 1 });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][1]).toBe(0); // index of the failed run
    // The second run still completed despite the first throwing.
    expect(client.completeRun).toHaveBeenCalledTimes(1);
  });
});
