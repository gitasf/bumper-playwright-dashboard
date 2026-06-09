import { describe, it, expect, vi } from "vite-plus/test";
import { drainStaleRuns } from "@/lib/ingest";

/**
 * `drainStaleRuns` (`@/lib/ingest`) is the watchdog's budget policy as a PURE
 * orchestrator: given the already-selected stale rows and a per-run finalizer,
 * it drains them in bounded-concurrency `Promise.allSettled` waves, tolerates a
 * stuck run's failure without aborting the pass, and tallies the outcome. The D1
 * SELECT (with its `.limit` budget) lives in `sweepStaleRuns` and is the
 * untestable-in-vitest part (the `void/db` stub throws on access); the policy
 * that protects the watchdog from self-DoSing under a mass-stranding event is
 * exactly this function, so it gets unit-tested against a fake finalizer.
 *
 * Guards F81: the old cron drained an unbounded SELECT strictly serially, so a
 * mass-stranding event blew the Workers subrequest/CPU budget mid-drain and the
 * invocation was killed. These tests pin (1) bounded concurrency — no more than
 * `chunkSize` finalizations in flight at once, (2) partial-failure tolerance —
 * one rejecting run never aborts the rest, (3) accurate found/finalized/failed
 * counting, and (4) per-failure error reporting with the offending run.
 */

const RUNS = Array.from({ length: 25 }, (_, i) => ({
  id: `run-${i}`,
  projectId: `proj-${i % 3}`,
}));

describe("drainStaleRuns", () => {
  it("finalizes every run and tallies found/finalized with zero failures", async () => {
    const finalize = vi.fn(() => Promise.resolve());

    const result = await drainStaleRuns(RUNS, finalize, { chunkSize: 10 });

    expect(result).toEqual({ found: 25, finalized: 25, failed: 0 });
    expect(finalize).toHaveBeenCalledTimes(25);
  });

  it("returns all-zero counts and never calls finalize for an empty batch", async () => {
    const finalize = vi.fn(() => Promise.resolve());

    const result = await drainStaleRuns([], finalize, { chunkSize: 10 });

    expect(result).toEqual({ found: 0, finalized: 0, failed: 0 });
    expect(finalize).not.toHaveBeenCalled();
  });

  it("never runs more than chunkSize finalizations concurrently", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let done = false;
    // Resolvers for the promises currently parked in flight.
    let pending: Array<() => void> = [];

    const finalize = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          pending.push(() => {
            inFlight--;
            resolve();
          });
        }),
    );

    const chunkSize = 4;
    const promise = drainStaleRuns(RUNS, finalize, { chunkSize }).then((r) => {
      done = true;
      return r;
    });

    // Drain wave-by-wave: a fresh wave only starts once the previous
    // `allSettled` settles, so release whatever is parked, yield the
    // event loop for the next wave to register, and repeat until done.
    // oxlint-disable-next-line no-unmodified-loop-condition -- `done` is flipped by the awaited drain promise's `.then` above; the linter can't see the cross-async mutation
    while (!done) {
      const wave = pending;
      pending = [];
      for (const resolve of wave) resolve();
      await new Promise((r) => setTimeout(r, 0));
    }

    const result = await promise;

    expect(result.finalized).toBe(25);
    // Bounded concurrency: never more than a full chunk in flight at once.
    expect(maxInFlight).toBeLessThanOrEqual(chunkSize);
    expect(maxInFlight).toBeGreaterThan(0);
  });

  it("tolerates a rejecting run: the survivors still finalize and failures are counted", async () => {
    const finalize = vi.fn((run: { id: string }) =>
      run.id === "run-7" || run.id === "run-20"
        ? Promise.reject(new Error(`boom ${run.id}`))
        : Promise.resolve(),
    );

    const result = await drainStaleRuns(RUNS, finalize, { chunkSize: 10 });

    expect(result).toEqual({ found: 25, finalized: 23, failed: 2 });
    // Every run was attempted — a failure mid-wave did not abort the pass.
    expect(finalize).toHaveBeenCalledTimes(25);
  });

  it("reports each failure to onError with the offending run and the reason", async () => {
    const reason = new Error("d1 timeout");
    const finalize = (run: { id: string }) =>
      run.id === "run-5" ? Promise.reject(reason) : Promise.resolve();
    const onError = vi.fn();

    const result = await drainStaleRuns(RUNS, finalize, {
      chunkSize: 10,
      onError,
    });

    expect(result.failed).toBe(1);
    expect(onError).toHaveBeenCalledTimes(1);
    const [run, err] = onError.mock.calls[0]!;
    expect(run).toEqual({ id: "run-5", projectId: "proj-2" });
    expect(err).toBe(reason);
  });

  it("does not require an onError handler", async () => {
    const finalize = (run: { id: string }) =>
      run.id === "run-1"
        ? Promise.reject(new Error("nope"))
        : Promise.resolve();

    const result = await drainStaleRuns(RUNS, finalize, { chunkSize: 10 });

    expect(result).toEqual({ found: 25, finalized: 24, failed: 1 });
  });
});
