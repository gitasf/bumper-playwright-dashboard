import { describe, expect, it } from "vite-plus/test";
import { apiKeys, monitorExecutions } from "@schema";
import { staleExecutionsWhere } from "@/lib/monitors/monitors-repo";
import {
  orphanedSyntheticKeysWhere,
  SYNTHETIC_KEY_LABEL_PREFIX,
} from "@/lib/monitors/synthetic-key";

/**
 * The two reaper predicates, introspected through the test harness's `void/db`
 * stub (operators return `{ __op, args }` placeholders; the `sql` tag captures
 * its template strings + interpolations). Both guard in-flight work from being
 * destroyed by a timestamp race:
 *
 *   - `staleExecutionsWhere` must age `running` executions from
 *     `coalesce(startedAt, createdAt)`, NOT `createdAt` — queue dwell before
 *     the claim is unbounded, so an execution claimed at minute 29 of a
 *     30-minute window would otherwise be reaped mid-flight at minute 30.
 *   - `orphanedSyntheticKeysWhere` must exclude keys whose owning execution is
 *     still `queued`/`running` — age alone races the execution lifecycle, and
 *     deleting a live key kills the in-container reporter's ingest auth
 *     mid-stream.
 */

interface Op {
  __op: string;
  args: unknown[];
}
interface SqlOp {
  __op: "sql";
  strings: readonly string[];
  args: unknown[];
}

describe("staleExecutionsWhere", () => {
  it("ages queued from createdAt and running from coalesce(startedAt, createdAt)", () => {
    const where = staleExecutionsWhere(9000) as unknown as Op;

    expect(where.__op).toBe("or");
    expect(where.args).toHaveLength(2);
    const [queuedArm, runningArm] = where.args as [Op, Op];

    expect(queuedArm.__op).toBe("and");
    const [queuedState, queuedAge] = queuedArm.args as [Op, Op];
    expect(queuedState.__op).toBe("eq");
    expect(queuedState.args[0]).toBe(monitorExecutions.state);
    expect(queuedState.args[1]).toBe("queued");
    expect(queuedAge.__op).toBe("lt");
    expect(queuedAge.args[0]).toBe(monitorExecutions.createdAt);
    expect(queuedAge.args[1]).toBe(9000);

    expect(runningArm.__op).toBe("and");
    const [runningState, runningAge] = runningArm.args as [Op, SqlOp];
    expect(runningState.__op).toBe("eq");
    expect(runningState.args[0]).toBe(monitorExecutions.state);
    expect(runningState.args[1]).toBe("running");
    // The load-bearing clock: startedAt (the claim transition stamp), with
    // createdAt only as the never-claimed fallback.
    expect(runningAge.__op).toBe("sql");
    expect(runningAge.strings.join("?")).toContain("coalesce");
    expect(runningAge.args[0]).toBe(monitorExecutions.startedAt);
    expect(runningAge.args[1]).toBe(monitorExecutions.createdAt);
    expect(runningAge.args[2]).toBe(9000);
  });
});

describe("orphanedSyntheticKeysWhere", () => {
  it("requires the synthetic label, the age cutoff, and NO in-flight owning execution", () => {
    const where = orphanedSyntheticKeysWhere(7000) as unknown as Op;

    expect(where.__op).toBe("and");
    expect(where.args).toHaveLength(3);
    const [labelMatch, age, notInFlight] = where.args as [Op, Op, SqlOp];

    expect(labelMatch.__op).toBe("like");
    expect(labelMatch.args[0]).toBe(apiKeys.label);
    expect(labelMatch.args[1]).toBe(`${SYNTHETIC_KEY_LABEL_PREFIX}%`);

    expect(age.__op).toBe("lt");
    expect(age.args[0]).toBe(apiKeys.createdAt);
    expect(age.args[1]).toBe(7000);

    // The execution id is the label suffix after the fixed prefix; the NOT
    // EXISTS keeps a key alive while that execution is queued/running.
    expect(notInFlight.__op).toBe("sql");
    const text = notInFlight.strings.join("?");
    expect(text).toContain("not exists");
    expect(text).toContain("substr");
    expect(text).toContain("in ('queued', 'running')");
    expect(notInFlight.args).toContain(monitorExecutions.id);
    expect(notInFlight.args).toContain(apiKeys.label);
    expect(notInFlight.args).toContain(SYNTHETIC_KEY_LABEL_PREFIX.length + 1);
    expect(notInFlight.args).toContain(monitorExecutions.state);
  });
});
