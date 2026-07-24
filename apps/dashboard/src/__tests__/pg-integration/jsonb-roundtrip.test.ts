// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

/**
 * jsonb round-trip integration — split out of the former monolithic
 * `pg-integration.test.ts` (see docs/worklog/2026-07-11-split-pg-integration-tests.md).
 * This file owns the "jsonb column survives as a JS object, never a
 * double-encoded string" domain across `monitors.config`,
 * `monitorExecutions.resultDetail`, and `auditLog.metadata` — executed
 * against the real schema (pglite by default, real node-postgres under
 * PG_TEST_URL). See `./harness.ts` for the shared hoisted-mock boot dance.
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
const { updateMonitor } = await import("@/lib/monitors/monitors-repo");
const { parseHttpMonitorConfig, HttpMonitorConfigSchema } =
  await import("@/lib/monitors/monitor-schemas");
const { auditLog, monitorExecutions, monitors } =
  await import("../../../db/schema");
const { eq } = await import("void/_db");

beforeAll(async () => {
  await resetTables(h.client, [auditLog, monitors, monitorExecutions]);
});

afterAll(async () => {
  await h.client.close();
});

describe("jsonb columns round-trip (object in → object out, no double-encoding)", () => {
  it("monitors.config survives updateMonitor as a JS object, not a JSON string", async () => {
    // Regression for the write-path double-encode: updateMonitor must store the
    // config object directly into the jsonb column (like createMonitor), not
    // JSON.stringify it — a stringified value comes back as a string and the
    // read-path parser rejects it as null, silently breaking the monitor.
    const scope = makeTenantScope({
      teamId: "t-mon",
      projectId: "p-mon",
      teamSlug: "mon",
      projectSlug: "mon",
    });
    const cfgA = HttpMonitorConfigSchema.parse({
      url: "https://a.example.com",
    });
    const cfgB = HttpMonitorConfigSchema.parse({
      url: "https://b.example.com",
    });
    await h.db.insert(monitors).values({
      id: "mon-cfg",
      teamId: scope.teamId,
      projectId: scope.projectId,
      name: "api",
      type: "http",
      enabled: 1,
      alertsEnabled: 1,
      alertTargets: null,
      source: null,
      config: cfgA,
      intervalSeconds: 60,
      schedulingStrategy: "round_robin",
      retryConfig: null,
      nextRunAt: null,
      lastEnqueuedAt: null,
      lastRunAt: null,
      lastStatus: null,
      createdBy: "u-mon",
      createdAt: 1000,
      updatedAt: 1000,
    });

    await updateMonitor(scope, "mon-cfg", { config: cfgB }, 2000);

    const [row] = await h.db
      .select({ config: monitors.config })
      .from(monitors)
      .where(eq(monitors.id, "mon-cfg"));
    // Pre-fix this is a string (JSON.stringify output) and the parse returns null.
    expect(typeof row?.config).toBe("object");
    expect(parseHttpMonitorConfig(row?.config)).toEqual(cfgB);
  });

  it("monitorExecutions.resultDetail stores + returns a JS object, never a string", async () => {
    const detail = {
      assertions: [],
      timings: { ttfbMs: 5, downloadMs: 2, totalMs: 9 },
      redirected: false,
      finalUrl: "https://example.com",
    };
    await h.db.insert(monitorExecutions).values({
      id: "me-json",
      projectId: "p-json",
      monitorId: "m-json",
      scheduledFor: 1000,
      state: "pass",
      attempt: 0,
      resultDetail: detail,
      createdAt: 1000,
    });
    const [row] = await h.db
      .select({ resultDetail: monitorExecutions.resultDetail })
      .from(monitorExecutions)
      .where(eq(monitorExecutions.id, "me-json"));
    // If the write stringified or the read didn't parse, this would be a string.
    expect(typeof row?.resultDetail).toBe("object");
    expect(row?.resultDetail).toEqual(detail);
  });

  it("auditLog.metadata round-trips an object; null stays null", async () => {
    await h.db.insert(auditLog).values([
      {
        id: "al-1",
        teamId: "t-json",
        actorUserId: "u-json",
        action: "member.role_change",
        metadata: { role: "viewer", extra: [1, 2] },
        createdAt: 1000,
      },
      {
        id: "al-2",
        teamId: "t-json",
        actorUserId: "u-json",
        action: "team.delete",
        metadata: null,
        createdAt: 1001,
      },
    ]);
    const rows = await h.db
      .select({ id: auditLog.id, metadata: auditLog.metadata })
      .from(auditLog)
      .where(eq(auditLog.teamId, "t-json"));
    const byId = new Map(rows.map((r) => [r.id, r.metadata]));
    expect(byId.get("al-1")).toEqual({ role: "viewer", extra: [1, 2] });
    expect(byId.get("al-2")).toBeNull();
  });
});
