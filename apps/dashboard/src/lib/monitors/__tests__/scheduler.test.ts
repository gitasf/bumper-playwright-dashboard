import { describe, expect, it } from "vite-plus/test";
import { planMonitorSweep } from "@/lib/monitors/scheduler";
import type { Monitor } from "@schema";

/**
 * `planMonitorSweep` (`@/lib/monitors/scheduler`) is the synthetic-monitor
 * scheduler's PURE decision: given the due monitors a sweep selected, it mints
 * one queued execution per monitor, re-arms each monitor's `nextRunAt = now +
 * intervalSeconds`, and builds the IDs-only queue jobs — all without touching
 * D1 (ids from an injected `makeId`, time from `now`, no `Date.now` /
 * `Math.random`). The persistence + the SELECT's `.limit` budget + the enqueue
 * loop live in `sweepDueMonitors`, which is the untestable-in-vitest part (the
 * `void/db` stub throws on access); the scheduling decision that decides what
 * runs and when the next tick fires is exactly this function, so it gets the
 * unit test.
 *
 * Pins: (1) one execution + one monitorUpdate + one job per due monitor, index
 * aligned; (2) `nextRunAt = now + intervalSeconds` (fixed cadence off the sweep
 * tick, not off completion); (3) `scheduledFor` = the monitor's pre-advance due
 * time; (4) ids come from the injected counter (determinism, no hidden RNG);
 * (5) an empty input yields a fully empty plan.
 */

/** Build a `Monitor` row with only the fields the planner reads set. */
function monitor(overrides: Partial<Monitor> & Pick<Monitor, "id">): Monitor {
  return {
    teamId: "team-1",
    projectId: "proj-1",
    name: "check",
    type: "browser",
    enabled: 1,
    source: "...",
    config: null,
    intervalSeconds: 300,
    schedulingStrategy: "round_robin",
    retryConfig: null,
    nextRunAt: 1000,
    lastEnqueuedAt: null,
    lastRunAt: null,
    lastStatus: null,
    createdBy: "user-1",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as Monitor;
}

/** Deterministic id generator: ex-1, ex-2, … (no Math.random / Date.now). */
function counterMakeId(): () => string {
  let n = 0;
  return () => `ex-${++n}`;
}

describe("planMonitorSweep", () => {
  it("returns an empty plan for no due monitors", () => {
    const plan = planMonitorSweep([], 5000, counterMakeId());
    expect(plan).toEqual({ executions: [], monitorUpdates: [], jobs: [] });
  });

  it("mints one execution + monitorUpdate + job per due monitor, index-aligned", () => {
    const now = 5000;
    const due = [
      monitor({
        id: "mon-a",
        projectId: "proj-1",
        intervalSeconds: 300,
        nextRunAt: 4800,
      }),
      monitor({
        id: "mon-b",
        projectId: "proj-2",
        intervalSeconds: 60,
        nextRunAt: 4999,
      }),
    ];

    const plan = planMonitorSweep(due, now, counterMakeId());

    expect(plan.executions).toEqual([
      {
        id: "ex-1",
        projectId: "proj-1",
        monitorId: "mon-a",
        scheduledFor: 4800,
      },
      {
        id: "ex-2",
        projectId: "proj-2",
        monitorId: "mon-b",
        scheduledFor: 4999,
      },
    ]);
    expect(plan.jobs).toEqual([
      { monitorId: "mon-a", executionId: "ex-1", scheduledFor: 4800 },
      { monitorId: "mon-b", executionId: "ex-2", scheduledFor: 4999 },
    ]);
  });

  it("re-arms nextRunAt to now + intervalSeconds and stamps lastEnqueuedAt = now", () => {
    const now = 5000;
    const due = [
      monitor({ id: "mon-a", intervalSeconds: 300, nextRunAt: 4800 }),
      monitor({ id: "mon-b", intervalSeconds: 60, nextRunAt: 4999 }),
    ];

    const plan = planMonitorSweep(due, now, counterMakeId());

    expect(plan.monitorUpdates).toEqual([
      { id: "mon-a", nextRunAt: 5300, lastEnqueuedAt: 5000 },
      { id: "mon-b", nextRunAt: 5060, lastEnqueuedAt: 5000 },
    ]);
  });

  it("falls back to now for scheduledFor when a due monitor has a null nextRunAt", () => {
    const now = 7000;
    const due = [
      monitor({ id: "mon-c", intervalSeconds: 600, nextRunAt: null }),
    ];

    const plan = planMonitorSweep(due, now, counterMakeId());

    expect(plan.executions[0]!.scheduledFor).toBe(7000);
    expect(plan.jobs[0]!.scheduledFor).toBe(7000);
    expect(plan.monitorUpdates[0]).toEqual({
      id: "mon-c",
      nextRunAt: 7600,
      lastEnqueuedAt: 7000,
    });
  });

  it("draws execution ids exclusively from the injected makeId", () => {
    const due = [
      monitor({ id: "mon-a" }),
      monitor({ id: "mon-b" }),
      monitor({ id: "mon-c" }),
    ];
    const issued: string[] = [];
    const makeId = () => {
      const id = `seq-${issued.length}`;
      issued.push(id);
      return id;
    };

    const plan = planMonitorSweep(due, 1000, makeId);

    expect(plan.executions.map((e) => e.id)).toEqual([
      "seq-0",
      "seq-1",
      "seq-2",
    ]);
    expect(issued).toHaveLength(3);
  });
});
