import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { TenantScope } from "@/lib/scope";

/**
 * `@/lib/runs/read-model` is the canonical by-id run read-model: ONE
 * tenant-scoped fetch+unwrap (`loadRunColumns`) behind the three run-summary
 * surfaces (MCP `get_run`, public `GET /api/v1/runs/:runId`, the session
 * `/runs/:runId/summary` route) and ONE shared base projection
 * (`RUN_SUMMARY_COLUMNS`). Mirrors `run-diff.workers.test.ts`'s controllable
 * void/db mock: a chainable spy records the select/from/where/limit so we can
 * pin the two invariants that make it safe to route every surface through it:
 *
 *  1. The fetch is ALWAYS scoped via `runByIdWhere` — the recorded WHERE is
 *     exactly `and(eq(projectId, scope.projectId), eq(id, runId))`, never a
 *     bare `eq(id, …)` a leaked run id could satisfy cross-project.
 *  2. The unwrap contract — the caller's column object passes through to
 *     `select(...)` untouched, `limit(1)` bounds the read, the single row
 *     comes back as-is, and a scope miss yields `null` (callers map to 404).
 *
 * Plus the base-projection contract: every `RUN_SUMMARY_COLUMNS` key projects
 * the `runs` column of the same name, and the per-surface extras
 * (`ciProvider`/`playwrightVersion` are MCP's, `expectedTotalTests` is v1's)
 * and the `idempotencyKey` write credential stay OUT — so cross-surface
 * divergence remains an explicit `{ ...base, extra }` pick at the call sites.
 */

// ─── Controllable void/db mock ───────────────────────────────────────────────

let capturedColumns: unknown = null;
let capturedFrom: unknown = null;
let capturedWhere: unknown = null;
let capturedLimit: unknown = null;
let resultRows: unknown[] = [];

vi.mock("void/db", async () => {
  const stub = await import("./helpers/void-db-stub");
  const node: Record<string, unknown> = {};
  node.from = (table: unknown) => {
    capturedFrom = table;
    return node;
  };
  node.where = (w: unknown) => {
    capturedWhere = w;
    return node;
  };
  node.limit = (n: unknown) => {
    capturedLimit = n;
    return node;
  };
  (node as { then: unknown }).then = (onFulfilled?: (v: unknown) => unknown) =>
    Promise.resolve(onFulfilled ? onFulfilled(resultRows) : resultRows);

  const db = {
    select: (columns: unknown) => {
      capturedColumns = columns;
      return node;
    },
  };
  return { ...stub, db };
});

const { runs } = await import("@schema");
const { loadRunColumns, RUN_SUMMARY_COLUMNS } =
  await import("@/lib/runs/read-model");

type RecordedOp = { __op: string; args: readonly unknown[] };

/** Read back `{ column, value }` from a recorded `eq(col, val)` op. */
function readEq(node: unknown): { column: string; value: unknown } {
  const op = node as RecordedOp;
  expect(op.__op).toBe("eq");
  const column = (op.args[0] as { name?: unknown })?.name;
  expect(typeof column).toBe("string");
  return { column: column as string, value: op.args[1] };
}

/** The `(column → value)` pairs ANDed together inside a recorded `and(...)`. */
function readAndPairs(node: unknown): Record<string, unknown> {
  const op = node as RecordedOp;
  expect(op.__op).toBe("and");
  const pairs: Record<string, unknown> = {};
  for (const child of op.args) {
    const { column, value } = readEq(child);
    pairs[column] = value;
  }
  return pairs;
}

const scope: TenantScope = {
  teamId: "team_abc" as TenantScope["teamId"],
  projectId: "proj_xyz" as TenantScope["projectId"],
  teamSlug: "acme",
  projectSlug: "web",
};

const otherScope: TenantScope = {
  teamId: "team_def" as TenantScope["teamId"],
  projectId: "proj_OTHER" as TenantScope["projectId"],
  teamSlug: "other",
  projectSlug: "site",
};

beforeEach(() => {
  capturedColumns = null;
  capturedFrom = null;
  capturedWhere = null;
  capturedLimit = null;
  resultRows = [];
});

// ─── loadRunColumns ──────────────────────────────────────────────────────────

describe("loadRunColumns", () => {
  it("scopes the fetch via runByIdWhere — projectId AND id, off the branded scope", async () => {
    await loadRunColumns(scope, "run_123", RUN_SUMMARY_COLUMNS);
    expect(readAndPairs(capturedWhere)).toEqual({
      projectId: "proj_xyz",
      id: "run_123",
    });
  });

  it("binds a different scope's projectId (cross-tenant isolation)", async () => {
    await loadRunColumns(otherScope, "run_123", RUN_SUMMARY_COLUMNS);
    expect(readAndPairs(capturedWhere)).toEqual({
      projectId: "proj_OTHER",
      id: "run_123",
    });
  });

  it("selects the caller's columns from runs, bounded by limit 1", async () => {
    await loadRunColumns(scope, "run_123", RUN_SUMMARY_COLUMNS);
    expect(capturedColumns).toBe(RUN_SUMMARY_COLUMNS);
    expect(capturedFrom).toBe(runs);
    expect(capturedLimit).toBe(1);
  });

  it("unwraps the single matching row as-is", async () => {
    const row = { id: "run_123", status: "passed" };
    resultRows = [row];
    await expect(
      loadRunColumns(scope, "run_123", { id: runs.id, status: runs.status }),
    ).resolves.toBe(row);
  });

  it("returns null when no row matches (callers map it to 404)", async () => {
    resultRows = [];
    await expect(
      loadRunColumns(scope, "run_missing", { id: runs.id }),
    ).resolves.toBeNull();
  });
});

// ─── RUN_SUMMARY_COLUMNS ─────────────────────────────────────────────────────

describe("RUN_SUMMARY_COLUMNS", () => {
  it("projects every key from the runs column of the same name (no transposition)", () => {
    for (const [key, column] of Object.entries(RUN_SUMMARY_COLUMNS)) {
      expect((column as { name?: unknown }).name, `column "${key}"`).toBe(key);
    }
  });

  it("is exactly the cross-surface base — per-surface extras and secrets stay out", () => {
    expect(Object.keys(RUN_SUMMARY_COLUMNS).sort()).toEqual([
      "actor",
      "branch",
      "commitMessage",
      "commitSha",
      "completedAt",
      "createdAt",
      "durationMs",
      "environment",
      "failed",
      "flaky",
      "id",
      "origin",
      "passed",
      "prNumber",
      "repo",
      "skipped",
      "status",
      "totalTests",
    ]);
    // MCP's extras, v1's extra, and the write credential must never join the
    // base — they are explicit `{ ...base, extra }` picks at their surfaces.
    for (const excluded of [
      "ciProvider",
      "playwrightVersion",
      "expectedTotalTests",
      "idempotencyKey",
    ]) {
      expect(RUN_SUMMARY_COLUMNS).not.toHaveProperty(excluded);
    }
  });
});
