import { describe, expect, it } from "vite-plus/test";
import { projectRoomServerSchema } from "@/realtime/events";
import type { ProjectFeedEvent } from "@/realtime/events";
import { applyMonitorFeedEvent } from "../../pages/t/[teamSlug]/p/[projectSlug]/monitors/monitor-feed";
import { RECENT_EXECUTION_WINDOW } from "../../pages/t/[teamSlug]/p/[projectSlug]/monitors/monitors-ui.shared";
import type { Props } from "../../pages/t/[teamSlug]/p/[projectSlug]/monitors/index.server";

/**
 * `applyMonitorFeedEvent` is the monitors-list twin of `applyProjectFeedEvent`:
 * the one place a live `monitor-result` folds into a roster row (status,
 * last-run, history strip, uptime). Both reducers consume the SAME per-project
 * room, so this also pins that each ignores the other's events. Tested without
 * React or a live socket (the `import type` of the loader props is erased, so no
 * `void/*` is pulled into the harness).
 */

type MonitorRow = Props["monitors"][number];
type ExecRow = MonitorRow["recentExecutions"][number];

function exec(over: Partial<ExecRow> = {}): ExecRow {
  return {
    id: "ex-1",
    state: "pass",
    runId: "run-1",
    createdAt: 2000,
    durationMs: null,
    statusCode: null,
    ...over,
  };
}

function monitorRow(over: Partial<MonitorRow> = {}): MonitorRow {
  return {
    id: "m1",
    name: "Homepage",
    type: "browser",
    enabled: 1,
    intervalSeconds: 60,
    lastStatus: "pass",
    lastRunAt: 1000,
    recentExecutions: [],
    uptime: null,
    ...over,
  };
}

function result(
  over: Partial<Extract<ProjectFeedEvent, { type: "monitor-result" }>> = {},
): ProjectFeedEvent {
  return {
    type: "monitor-result",
    monitorId: "m1",
    lastStatus: "fail",
    lastRunAt: 5000,
    execution: exec({ id: "ex-new", state: "fail" }),
    ...over,
  };
}

describe("applyMonitorFeedEvent", () => {
  it("advances the matching row's status, last-run, strip, and uptime", () => {
    const rows = [
      monitorRow({
        id: "m1",
        lastStatus: "pass",
        lastRunAt: 1000,
        recentExecutions: [
          exec({ id: "ex-a", state: "pass" }),
          exec({ id: "ex-b", state: "pass" }),
        ],
        uptime: 100,
      }),
      monitorRow({ id: "m2" }),
    ];

    const next = applyMonitorFeedEvent(rows, result());

    expect(next[0]).toMatchObject({ lastStatus: "fail", lastRunAt: 5000 });
    // Newest execution prepended; static metadata preserved; other rows untouched.
    expect(next[0]!.recentExecutions.map((e) => e.id)).toEqual([
      "ex-new",
      "ex-a",
      "ex-b",
    ]);
    expect(next[0]!.name).toBe("Homepage");
    expect(next[1]).toBe(rows[1]);
    // Uptime recomputed off [fail, pass, pass] → 2 of 3 countable pass.
    expect(next[0]!.uptime).toBeCloseTo((2 / 3) * 100, 5);
  });

  it("carries the widened execution fields (durationMs, statusCode) onto the strip", () => {
    const rows = [monitorRow({ id: "m1", recentExecutions: [] })];
    const next = applyMonitorFeedEvent(
      rows,
      result({
        execution: exec({
          id: "ex-http",
          state: "pass",
          durationMs: 142,
          statusCode: 200,
        }),
      }),
    );
    expect(next[0]!.recentExecutions[0]).toMatchObject({
      id: "ex-http",
      durationMs: 142,
      statusCode: 200,
    });
  });

  it("is a no-op (same array reference) when the monitor isn't displayed", () => {
    const rows = [monitorRow({ id: "m1" })];
    expect(applyMonitorFeedEvent(rows, result({ monitorId: "ghost" }))).toBe(
      rows,
    );
  });

  it("dedupes a redelivered settle with the SAME outcome (no-op, same reference)", () => {
    const rows = [
      monitorRow({
        id: "m1",
        recentExecutions: [exec({ id: "ex-dup", state: "fail" })],
      }),
    ];
    const next = applyMonitorFeedEvent(
      rows,
      result({ execution: exec({ id: "ex-dup", state: "fail" }) }),
    );
    expect(next).toBe(rows);
  });

  it("updates the entry in place when a redelivery CORRECTS the outcome (infra error → pass)", () => {
    const rows = [
      monitorRow({
        id: "m1",
        lastStatus: "error",
        recentExecutions: [
          exec({ id: "ex-x", state: "error", runId: null }),
          exec({ id: "ex-old", state: "pass" }),
        ],
        uptime: 50,
      }),
    ];

    const next = applyMonitorFeedEvent(
      rows,
      result({
        lastStatus: "pass",
        execution: exec({ id: "ex-x", state: "pass", runId: "run-x" }),
      }),
    );

    expect(next).not.toBe(rows);
    expect(next[0]!.lastStatus).toBe("pass");
    // Replaced in place — not dropped, not duplicated.
    expect(next[0]!.recentExecutions.map((e) => e.id)).toEqual([
      "ex-x",
      "ex-old",
    ]);
    expect(next[0]!.recentExecutions[0]!.state).toBe("pass");
    // Uptime recomputed off the corrected window [pass, pass].
    expect(next[0]!.uptime).toBe(100);
  });

  it("trims the strip back to the shared window as executions stream in", () => {
    const recentExecutions = Array.from(
      { length: RECENT_EXECUTION_WINDOW },
      (_, i) => exec({ id: `ex-${i}`, createdAt: 1000 - i }),
    );
    const rows = [monitorRow({ id: "m1", recentExecutions })];

    const next = applyMonitorFeedEvent(
      rows,
      result({ execution: exec({ id: "ex-new", state: "pass" }) }),
    );

    expect(next[0]!.recentExecutions).toHaveLength(RECENT_EXECUTION_WINDOW);
    expect(next[0]!.recentExecutions[0]!.id).toBe("ex-new");
  });

  it("ignores the runs-list events (shared room, separate reducers)", () => {
    const rows = [monitorRow({ id: "m1" })];
    const runProgress: ProjectFeedEvent = {
      type: "run-progress",
      runId: "r1",
      summary: {
        totalTests: 1,
        passed: 1,
        failed: 0,
        flaky: 0,
        skipped: 0,
        durationMs: 1,
        status: "passed",
        completedAt: 1,
      },
    };
    expect(applyMonitorFeedEvent(rows, runProgress)).toBe(rows);
  });
});

describe("project room schema (monitor-result)", () => {
  it("accepts a well-formed monitor-result event", () => {
    const r = projectRoomServerSchema["~standard"].validate({
      type: "monitor-result",
      monitorId: "m1",
      lastStatus: "fail",
      lastRunAt: 5000,
      execution: { id: "ex-new", state: "fail", runId: null, createdAt: 2000 },
    });
    expect("issues" in r && r.issues).toBeFalsy();
  });

  it("accepts an execution carrying the widened http fields (durationMs, statusCode)", () => {
    const r = projectRoomServerSchema["~standard"].validate({
      type: "monitor-result",
      monitorId: "m1",
      lastStatus: "pass",
      lastRunAt: 6000,
      execution: {
        id: "ex-http",
        state: "pass",
        runId: null,
        createdAt: 3000,
        durationMs: 142,
        statusCode: 200,
      },
    });
    expect("issues" in r && r.issues).toBeFalsy();
  });

  it("rejects a monitor-result whose execution is malformed (no string id)", () => {
    const r = projectRoomServerSchema["~standard"].validate({
      type: "monitor-result",
      monitorId: "m1",
      lastStatus: "fail",
      lastRunAt: 5000,
      execution: { state: "fail" },
    });
    expect("issues" in r && r.issues).toBeTruthy();
  });
});
