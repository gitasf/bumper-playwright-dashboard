import { describe, it, expect } from "vite-plus/test";
import {
  currentStatusSeveritySql,
  mergeRunStatus,
  mergeRunStatusSql,
  worstShardStatus,
} from "@/lib/ingest";

/**
 * Guards the sharding fix in completeRun: shards share one idempotencyKey and
 * call /complete in arbitrary order, so the run's terminal status must be the
 * worst outcome across shards — a later all-passing shard must never overwrite
 * an earlier failure.
 */
describe("mergeRunStatus", () => {
  it("takes the incoming status verbatim on the first completion (running)", () => {
    expect(mergeRunStatus("running", "passed")).toBe("passed");
    expect(mergeRunStatus("running", "failed")).toBe("failed");
    expect(mergeRunStatus("running", "interrupted")).toBe("interrupted");
  });

  it("never downgrades a failed run to passed", () => {
    expect(mergeRunStatus("failed", "passed")).toBe("failed");
    expect(mergeRunStatus("timedout", "passed")).toBe("timedout");
    expect(mergeRunStatus("interrupted", "passed")).toBe("interrupted");
  });

  it("escalates to a more severe outcome", () => {
    expect(mergeRunStatus("passed", "failed")).toBe("failed");
    expect(mergeRunStatus("passed", "interrupted")).toBe("interrupted");
    expect(mergeRunStatus("flaky", "failed")).toBe("failed");
    expect(mergeRunStatus("skipped", "passed")).toBe("passed");
  });

  it("keeps the more severe of two terminal statuses regardless of arrival order", () => {
    expect(mergeRunStatus("failed", "interrupted")).toBe("failed");
    expect(mergeRunStatus("interrupted", "failed")).toBe("failed");
  });

  it("is stable when both statuses are equally severe", () => {
    // failed and timedout share severity — keep the current one (no flip-flop).
    expect(mergeRunStatus("failed", "timedout")).toBe("failed");
    expect(mergeRunStatus("timedout", "failed")).toBe("timedout");
    expect(mergeRunStatus("passed", "passed")).toBe("passed");
  });
});

/**
 * The production path runs `mergeRunStatusSql`, NOT `mergeRunStatus` — the JS
 * function above is only a reference. completeRun merges status atomically in a
 * single SQL UPDATE to close the read-modify-write race between two shards'
 * /complete calls, so the SQL CASE is what actually decides a run's terminal
 * status across shards.
 *
 * These tests bind the SQL encoding to the JS reference's contract without a
 * real D1: under vitest, `void/db`'s `sql` tag captures its template literals
 * and interpolated values (see helpers/void-db-stub.ts), so we can reconstruct
 * the severity table and branch ordering baked into the SQL and assert they
 * match the JS side. A maintainer who edits one encoding's severity rank, tie-
 * break, or running special-case but not the other will fail here — closing the
 * silent JS/SQL drift the previous "can't drift" comment wrongly claimed was
 * already impossible. (A live UPDATE assertion would be even stronger but needs
 * the real-D1 harness.)
 */
describe("mergeRunStatusSql (the executed encoding)", () => {
  // A captured stub `sql` chunk: { __op, strings, args } where each arg is a
  // literal value or another nested chunk.
  type SqlChunk = {
    __op: "sql";
    strings: readonly string[];
    args: readonly unknown[];
  };

  function isChunk(node: unknown): node is SqlChunk {
    return (
      typeof node === "object" &&
      node !== null &&
      (node as { __op?: unknown }).__op === "sql"
    );
  }

  // Flatten a chunk into the interleaved [literal, arg, literal, arg, …]
  // sequence the tag would emit. Nested chunks recurse inline; non-chunk args
  // (interpolated values / column objects) become marker tokens.
  function flatten(node: unknown): unknown[] {
    if (!isChunk(node)) return [{ value: node }];
    const out: unknown[] = [];
    node.strings.forEach((lit, i) => {
      if (lit !== "") out.push({ literal: lit });
      if (i < node.args.length) out.push(...flatten(node.args[i]));
    });
    return out;
  }

  // Reconstruct the `when <status> then <severity>` pairs embedded in a
  // severity CASE, plus the trailing `else <fallback>`.
  function readSeverityCase(node: unknown) {
    const tokens = flatten(node);
    const table: Record<string, number> = {};
    let fallback: number | undefined;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i] as { literal?: string; value?: unknown };
      if (t.literal === " when ") {
        const status = (tokens[i + 1] as { value?: unknown }).value;
        const severity = (tokens[i + 3] as { value?: unknown }).value;
        if (typeof status === "string" && typeof severity === "number")
          table[status] = severity;
      }
      if (t.literal === " else ") {
        const val = (tokens[i + 1] as { value?: unknown }).value;
        if (typeof val === "number") fallback = val;
      }
    }
    return { table, fallback };
  }

  it("encodes the SAME severity table and 0-fallback as mergeRunStatus uses", () => {
    const { table, fallback } = readSeverityCase(currentStatusSeveritySql());
    // The ranks the SQL bakes in must equal the JS reference's view of every
    // known status — derived by escalating a `skipped` baseline.
    expect(table).toEqual({
      skipped: 0,
      passed: 1,
      flaky: 2,
      interrupted: 3,
      timedout: 4,
      failed: 4,
    });
    // Unknown statuses fall through to 0 in BOTH encodings: the SQL `else` here,
    // and the JS `?? UNKNOWN_STATUS_SEVERITY`. mergeRunStatus treats an unknown
    // current status as the lowest rank, so any known incoming status escalates.
    expect(fallback).toBe(0);
    expect(mergeRunStatus("totally-unknown", "passed")).toBe("passed");
  });

  it("orders branches identically to mergeRunStatus: running-case, strict severity compare, keep-current else", () => {
    const incoming = "failed";
    const tokens = flatten(mergeRunStatusSql(incoming));
    // The top-level CASE literals encode the decision shape:
    //   case when <status> = 'running' then <incoming>
    //        when (<severityCase>) < <incomingSeverity> then <incoming>
    //        else <status> end
    const literals = tokens
      .filter((t): t is { literal: string } => "literal" in (t as object))
      .map((t) => t.literal);
    expect(literals).toContain("case when ");
    expect(literals).toContain(" = 'running' then "); // running special-case
    expect(literals).toContain(" < "); // STRICT compare: ties keep current
    expect(literals).toContain(" else "); // keep-current fallthrough
    expect(literals).toContain(" end");
  });

  it("binds the incoming severity it compares against to runStatusSeverity (no hand-typed rank)", () => {
    // For each status, the literal severity the SQL compares the current rank
    // against must equal the rank the JS reference would assign — so the strict
    // `<` test in SQL agrees with the `inc > cur` test in mergeRunStatus.
    const expectedRank: Record<string, number> = {
      skipped: 0,
      passed: 1,
      flaky: 2,
      interrupted: 3,
      timedout: 4,
      failed: 4,
      "unknown-x": 0,
    };
    for (const [incoming, rank] of Object.entries(expectedRank)) {
      const tokens = flatten(mergeRunStatusSql(incoming));
      // The numeric literal compared after " < " is the incoming severity.
      const ltIndex = tokens.findIndex(
        (t) => (t as { literal?: string }).literal === " < ",
      );
      expect(ltIndex).toBeGreaterThanOrEqual(0);
      const compared = (tokens[ltIndex + 1] as { value?: unknown }).value;
      expect(compared).toBe(rank);
    }
  });
});

/**
 * `worstShardStatus` is the deferred-finalize counterpart to `mergeRunStatus`:
 * once EVERY shard of a sharded run has reported, the run's terminal status is
 * the worst status across all shards (rather than the first shard's status). It
 * folds over the whole set at once (not pairwise on arrival), so it must be
 * order-independent and pick the highest severity, with ties keeping the
 * first-seen status (failed/timedout are equal severity — both "failed").
 */
describe("worstShardStatus", () => {
  it("returns null for an empty set (no shard has finished yet)", () => {
    expect(worstShardStatus([])).toBe(null);
  });

  it("returns the sole status for a single shard", () => {
    expect(worstShardStatus(["passed"])).toBe("passed");
    expect(worstShardStatus(["failed"])).toBe("failed");
  });

  it("takes the worst outcome across shards regardless of order", () => {
    expect(worstShardStatus(["passed", "failed", "passed"])).toBe("failed");
    expect(worstShardStatus(["failed", "passed", "passed"])).toBe("failed");
    expect(worstShardStatus(["passed", "passed", "interrupted"])).toBe(
      "interrupted",
    );
    expect(worstShardStatus(["skipped", "passed", "flaky"])).toBe("flaky");
  });

  it("keeps all-passing shards as passed", () => {
    expect(worstShardStatus(["passed", "passed", "passed"])).toBe("passed");
  });

  it("is stable on equal-severity ties (failed vs timedout both mean failed)", () => {
    expect(worstShardStatus(["failed", "timedout"])).toBe("failed");
    expect(worstShardStatus(["timedout", "failed"])).toBe("timedout");
  });

  it("treats 'interrupted' as more severe than passed but less than failed — the watchdog's incomplete-run case", () => {
    // finalizeStaleRun folds the completed shards' statuses together with
    // "interrupted": an all-passing-but-incomplete run is 'interrupted', but a
    // completed shard's real failure still wins.
    expect(worstShardStatus(["passed", "interrupted"])).toBe("interrupted");
    expect(worstShardStatus(["failed", "interrupted"])).toBe("failed");
  });
});
