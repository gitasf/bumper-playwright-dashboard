import { describe, expect, it } from "vite-plus/test";
import { buildRunInsertValues } from "@/lib/ingest";
import { makeTenantScope } from "@/lib/scope";
import type { OpenRunPayload } from "@/lib/schemas";

/**
 * `buildRunInsertValues` is the single pure derivation of the `runs` row from an
 * open payload — the `db.insert(runs)` call site itself can't run under the
 * vitest harness (it touches the live D1 binding), so this is where the
 * field-mapping contract is pinned.
 *
 * The load-bearing case is the synthetic-monitoring provenance: `origin` /
 * `monitorId` were accepted by the validator and sent by the reporter/stub but
 * silently dropped at the insert, so every synthetic run persisted as a plain
 * `ci` run. These tests lock the mapping so that regression can't recur.
 */

const SCOPE = makeTenantScope({
  teamId: "team-1",
  projectId: "proj-1",
  teamSlug: "acme",
  projectSlug: "web",
});

function payload(run: Partial<OpenRunPayload["run"]> = {}): OpenRunPayload {
  return {
    idempotencyKey: "idem-1",
    run: { plannedTests: [], ...run },
  };
}

describe("buildRunInsertValues", () => {
  it("defaults a CI run to origin='ci' with a null monitorId", () => {
    const row = buildRunInsertValues("run-1", SCOPE, payload(), 1000);

    expect(row.origin).toBe("ci");
    expect(row.monitorId).toBe(null);
  });

  it("carries synthetic provenance through to the row (the regression)", () => {
    const row = buildRunInsertValues(
      "run-1",
      SCOPE,
      payload({ origin: "synthetic", monitorId: "mon-9" }),
      1000,
    );

    expect(row.origin).toBe("synthetic");
    expect(row.monitorId).toBe("mon-9");
  });

  it("keeps an explicit origin='ci' as-is", () => {
    const row = buildRunInsertValues(
      "run-1",
      SCOPE,
      payload({ origin: "ci" }),
      1000,
    );

    expect(row.origin).toBe("ci");
  });

  it("seeds identity, scope, liveness, and the running status", () => {
    const row = buildRunInsertValues("run-1", SCOPE, payload(), 1000);

    expect(row).toMatchObject({
      id: "run-1",
      teamId: "team-1",
      projectId: "proj-1",
      idempotencyKey: "idem-1",
      status: "running",
      createdAt: 1000,
      // Seeded at open so an onBegin-only dead run is still sweepable.
      lastActivityAt: 1000,
      completedAt: null,
    });
  });
});
