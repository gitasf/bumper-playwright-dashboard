import { describe, expect, it } from "vite-plus/test";
import type { TestResultInput } from "@/lib/schemas";
import {
  dedupeResultsByTestId,
  RUN_WRITE_GRACE_SECONDS,
  runClosedForWrites,
} from "@/lib/ingest";

function result(over: Partial<TestResultInput> = {}): TestResultInput {
  return {
    testId: "t1",
    title: "adds",
    file: "math.spec.ts",
    status: "passed",
    durationMs: 10,
    retryCount: 0,
    attempts: [{ attempt: 0, status: "passed", durationMs: 10 }],
    tags: [],
    annotations: [],
    ...over,
  } as TestResultInput;
}

/**
 * Two payload entries sharing one NEW testId would share one assigned ULID and
 * blow the testResults PK — a 500 for the whole batch. The dedupe makes the
 * batch total: last write wins (matching what the UPDATE path would leave).
 */
describe("dedupeResultsByTestId", () => {
  it("returns the input untouched when all testIds are unique", () => {
    const results = [result({ testId: "a" }), result({ testId: "b" })];
    expect(dedupeResultsByTestId(results)).toBe(results);
  });

  it("keeps the LAST occurrence of a duplicated testId", () => {
    const first = result({ testId: "a", status: "passed" });
    const second = result({ testId: "a", status: "failed" });
    const deduped = dedupeResultsByTestId([first, second]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]).toBe(second);
  });

  it("preserves the first-occurrence ordering of surviving entries", () => {
    const deduped = dedupeResultsByTestId([
      result({ testId: "a", status: "passed" }),
      result({ testId: "b" }),
      result({ testId: "a", status: "failed" }),
    ]);
    expect(deduped.map((r) => r.testId)).toEqual(["a", "b"]);
    expect(deduped[0]!.status).toBe("failed");
  });
});

/**
 * Straggler tolerance is bounded on ACTIVITY, not just completion: a terminal
 * run keeps accepting ingest writes while anything is still writing to it
 * (late shards, upload tails), and `openRun`'s duplicate path re-arms the
 * window for legitimate re-streams (CI re-runs, seeders). Only a terminal run
 * IDLE past the grace window refuses writes — the bound that stops a
 * compromised API key from rewriting months-old runs via a leaked runId.
 */
describe("runClosedForWrites", () => {
  const now = 1_000_000;
  const stale = now - RUN_WRITE_GRACE_SECONDS - 1;

  it("never closes a running run", () => {
    expect(
      runClosedForWrites(
        { status: "running", completedAt: null, lastActivityAt: null },
        now,
      ),
    ).toBe(false);
    expect(
      runClosedForWrites(
        { status: "running", completedAt: stale, lastActivityAt: stale },
        now,
      ),
    ).toBe(false);
  });

  it("keeps a terminal run open within the grace window of completion", () => {
    const completedAt = now - RUN_WRITE_GRACE_SECONDS;
    expect(
      runClosedForWrites(
        { status: "failed", completedAt, lastActivityAt: completedAt },
        now,
      ),
    ).toBe(false);
  });

  it("closes a terminal run idle past the grace window", () => {
    expect(
      runClosedForWrites(
        { status: "failed", completedAt: stale, lastActivityAt: stale },
        now,
      ),
    ).toBe(true);
  });

  it("stays open when recent ACTIVITY re-armed the window (re-run via openRun, late shard)", () => {
    // completedAt is months old, but a duplicate open / accepted write just
    // bumped lastActivityAt — the run accepts the re-stream.
    expect(
      runClosedForWrites(
        { status: "failed", completedAt: stale, lastActivityAt: now - 10 },
        now,
      ),
    ).toBe(false);
  });

  it("treats a terminal run without completedAt as open (watchdog owns it)", () => {
    expect(
      runClosedForWrites(
        { status: "failed", completedAt: null, lastActivityAt: stale },
        now,
      ),
    ).toBe(false);
  });
});
