// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

/**
 * `monitors-repo`'s raw-SQL reads — integration-only, alongside the rest of
 * `pg-integration/` (real node-postgres under `PG_TEST_URL`, pglite
 * otherwise; see `./harness.ts`).
 *
 * Currently covers `listRecentExecutionsByMonitor`'s single ranked query
 * (`row_number() over (partition by "monitorId" order by "createdAt" desc)`),
 * which replaced a per-monitor `Promise.all` fan-out — proving:
 *   - per-monitor limiting (`rn <= perMonitor`) and newest-first ordering;
 *   - tenant (`projectId`) + monitor-set scoping, so neither another project's
 *     nor another monitor's executions leak into the result;
 *   - the bigint columns it selects (`scheduledFor`/`startedAt`/`completedAt`/
 *     `createdAt`) come back as JS numbers, not the `int8`-as-string
 *     node-postgres hands back on this raw `runRows` path (pglite hides the
 *     trap — this is exactly the class of bug the real-postgres CI leg
 *     exists to catch).
 */

// Build the backing Drizzle instance BEFORE any import of the modules under
// test resolves `void/db` (vi.hoisted runs first).
const h = await vi.hoisted(async () => {
  const { buildHarness } = await import("./harness");
  return buildHarness();
});

// `void/db` → the harness instance, with the REAL Drizzle operators (incl.
// `sql`) from the non-intercepted `void/_db` entry.
vi.mock("void/db", async () => {
  const ops = await vi.importActual<Record<string, unknown>>("void/_db");
  return { ...ops, db: h.db };
});

// Mocked for consistency with the rest of this directory (unused here,
// harmless).
vi.mock("@/realtime/publish", () => ({
  broadcastRunRoom: () => Promise.resolve(),
  broadcastProjectRoom: () => Promise.resolve(),
}));

const { resetTables } = await import("./harness");
const { makeTenantScope } = await import("@/lib/scope");
const { listRecentExecutionsByMonitor } =
  await import("@/lib/monitors/monitors-repo");
const { monitorExecutions } = await import("../../../db/schema");

beforeAll(async () => {
  await resetTables(h.client, [monitorExecutions]);
});

afterAll(async () => {
  await h.client.close();
});

describe("listRecentExecutionsByMonitor (single ranked query)", () => {
  const scope = makeTenantScope({
    teamId: "t-exec",
    projectId: "p-exec",
    teamSlug: "acme",
    projectSlug: "exec",
  });
  const monitorA = "mon-a";
  const monitorB = "mon-b";
  const nowSec = 1_700_000_000;

  beforeAll(async () => {
    // Monitor A: 5 executions, newest first e.g. a5 (newest) .. a1 (oldest).
    for (let i = 1; i <= 5; i++) {
      await h.db.insert(monitorExecutions).values({
        id: `a${i}`,
        projectId: scope.projectId,
        monitorId: monitorA,
        scheduledFor: nowSec - (5 - i) * 60,
        startedAt: nowSec - (5 - i) * 60,
        completedAt: nowSec - (5 - i) * 60 + 1,
        state: "pass",
        attempt: 0,
        durationMs: 100 + i,
        statusCode: 200,
        resultDetail: { seq: i },
        createdAt: nowSec - (5 - i) * 60,
      });
    }
    // Monitor B: 2 executions.
    for (let i = 1; i <= 2; i++) {
      await h.db.insert(monitorExecutions).values({
        id: `b${i}`,
        projectId: scope.projectId,
        monitorId: monitorB,
        scheduledFor: nowSec - (2 - i) * 60,
        state: "fail",
        attempt: 0,
        durationMs: 200 + i,
        statusCode: 500,
        createdAt: nowSec - (2 - i) * 60,
      });
    }
    // A monitor with ZERO executions — must resolve to an absent map entry,
    // not an error or an empty-array crash.
    // (no rows inserted for "mon-empty")

    // Different project, same monitorId as A — must not leak into the result.
    await h.db.insert(monitorExecutions).values({
      id: "other-project",
      projectId: "p-other",
      monitorId: monitorA,
      scheduledFor: nowSec,
      state: "pass",
      attempt: 0,
      createdAt: nowSec,
    });

    // Same project, a monitor NOT in the requested id set — must not leak in.
    await h.db.insert(monitorExecutions).values({
      id: "unrequested-monitor",
      projectId: scope.projectId,
      monitorId: "mon-not-requested",
      scheduledFor: nowSec,
      state: "pass",
      attempt: 0,
      createdAt: nowSec,
    });
  });

  it("returns an empty map for an empty monitorIds list without querying", async () => {
    const result = await listRecentExecutionsByMonitor(scope, [], 24);
    expect(result.size).toBe(0);
  });

  it("limits to perMonitor rows per monitor, newest-first, per-monitor independently", async () => {
    const result = await listRecentExecutionsByMonitor(
      scope,
      [monitorA, monitorB, "mon-empty"],
      3,
    );

    const execA = result.get(monitorA) ?? [];
    expect(execA.map((e) => e.id)).toEqual(["a5", "a4", "a3"]);

    const execB = result.get(monitorB) ?? [];
    expect(execB.map((e) => e.id)).toEqual(["b2", "b1"]);

    // Zero-execution monitor has no map entry (callers read via `?? []`).
    expect(result.has("mon-empty")).toBe(false);
  });

  it("excludes another project's rows and an unrequested monitor's rows", async () => {
    const result = await listRecentExecutionsByMonitor(scope, [monitorA], 10);
    const ids = (result.get(monitorA) ?? []).map((e) => e.id);
    expect(ids).not.toContain("other-project");
    expect(ids).not.toContain("unrequested-monitor");
    expect(ids).toEqual(["a5", "a4", "a3", "a2", "a1"]);
  });

  it("returns bigint timestamp columns as JS numbers, and jsonb as an object", async () => {
    const result = await listRecentExecutionsByMonitor(scope, [monitorA], 1);
    const [latest] = result.get(monitorA) ?? [];
    expect(latest).toBeDefined();
    // The coercion guard the `cast(... as integer)`s exist for: on real
    // Postgres these are `int8` and node-postgres returns them as STRINGS
    // unless cast; pglite would parse them to numbers either way, hiding a
    // dropped cast — this assertion is only meaningful on the PG_TEST_URL CI
    // leg, but it's cheap to run everywhere.
    expect(typeof latest?.createdAt).toBe("number");
    expect(typeof latest?.scheduledFor).toBe("number");
    expect(typeof latest?.startedAt).toBe("number");
    expect(typeof latest?.completedAt).toBe("number");
    expect(latest?.createdAt).toBe(nowSec);
    expect(latest?.resultDetail).toEqual({ seq: 5 });
  });
});
