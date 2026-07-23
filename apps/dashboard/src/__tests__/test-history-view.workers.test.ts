import { describe, expect, it } from "vite-plus/test";
import {
  buildTestHistoryView,
  type TestHistoryRow,
} from "@/lib/test-history-view";

/**
 * Pins the shared per-test history view used by BOTH the run-scoped result
 * detail and the test-level history page (they previously hand-rolled an
 * identical copy). Guards the chronological ordering, the canonical status
 * bucketing (the hand-rolled version mis-scored `interrupted` as a pass), and
 * the current-point handling.
 */

const OPTS = {
  base: "/t/acme/p/web",
  teamSlug: "acme",
  projectSlug: "web",
} as const;

function row(
  over: Partial<TestHistoryRow> & { testResultId: string },
): TestHistoryRow {
  return {
    runId: `run-${over.testResultId}`,
    status: "passed",
    durationMs: 1000,
    createdAt: 1_000_000,
    branch: "main",
    commitSha: "abc1234def",
    ...over,
  };
}

describe("buildTestHistoryView", () => {
  it("reverses newest-first input into chronological points", () => {
    const { points } = buildTestHistoryView(
      [
        row({ testResultId: "r3" }),
        row({ testResultId: "r2" }),
        row({ testResultId: "r1" }),
      ],
      OPTS,
    );
    expect(points.map((p) => p.id)).toEqual(["r1", "r2", "r3"]);
  });

  it("buckets timedout→failed and interrupted→flaky via the canonical key", () => {
    // The latent bug the extraction fixed: `interrupted` is neither "failed"
    // nor "flaky" by string equality, so the old hand-rolled stats counted it
    // as a pass. statusGroupKey buckets it as flaky.
    const { stats } = buildTestHistoryView(
      [
        row({ testResultId: "r5", status: "passed" }),
        row({ testResultId: "r4", status: "interrupted" }),
        row({ testResultId: "r3", status: "timedout" }),
        row({ testResultId: "r2", status: "skipped" }),
        row({ testResultId: "r1", status: "passed" }),
      ],
      OPTS,
    );
    // skipped is excluded from `ran`; the rest count.
    expect(stats).toEqual({ ran: 4, failed: 1, flaky: 1, passPct: 50 });
  });

  it("reports 100% pass for an empty / all-skipped window", () => {
    expect(buildTestHistoryView([], OPTS).stats.passPct).toBe(100);
    expect(
      buildTestHistoryView(
        [row({ testResultId: "s", status: "skipped" })],
        OPTS,
      ).stats,
    ).toEqual({ ran: 0, failed: 0, flaky: 0, passPct: 100 });
  });

  it("links every point to its result by default", () => {
    const { points } = buildTestHistoryView(
      [row({ testResultId: "r1", runId: "run-9" })],
      OPTS,
    );
    expect(points[0]?.href).toBe("/t/acme/p/web/runs/run-9/tests/r1");
    expect(points[0]?.hover).toMatchObject({
      kind: "testResult",
      runId: "run-9",
      testResultId: "r1",
    });
    expect(points[0]?.current).toBeUndefined();
  });

  it("highlights the current point and drops its self-link, but keeps its hovercard", () => {
    const { points } = buildTestHistoryView(
      [row({ testResultId: "cur" }), row({ testResultId: "other" })],
      { ...OPTS, currentTestResultId: "cur" },
    );
    const cur = points.find((p) => p.id === "cur");
    const other = points.find((p) => p.id === "other");
    expect(cur?.current).toBe(true);
    expect(cur?.href).toBeUndefined();
    expect(cur?.hover).toMatchObject({
      kind: "testResult",
      testResultId: "cur",
    });
    expect(other?.current).toBeUndefined();
    expect(other?.href).toBeDefined();
  });

  it("builds a label of status · duration · … · branch · short sha, dropping nulls", () => {
    const [withMeta] = buildTestHistoryView(
      [
        row({
          testResultId: "r1",
          status: "passed",
          durationMs: 1500,
          branch: "main",
          commitSha: "abc1234def",
        }),
      ],
      OPTS,
    ).points;
    expect(withMeta?.label).toContain("passed");
    expect(withMeta?.label).toContain("1s");
    expect(withMeta?.label).toContain("main");
    expect(withMeta?.label).toContain("abc1234"); // 7-char short sha
    expect(withMeta?.label).not.toContain("abc1234def"); // full sha trimmed

    const [noMeta] = buildTestHistoryView(
      [row({ testResultId: "r1", branch: null, commitSha: null })],
      OPTS,
    ).points;
    // null branch + sha drop out — no trailing/double separators.
    expect(noMeta?.label?.endsWith("·")).toBe(false);
    expect(noMeta?.label).not.toContain("· ·");
  });
});
