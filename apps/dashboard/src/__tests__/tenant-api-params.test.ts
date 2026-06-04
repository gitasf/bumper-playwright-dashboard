import { describe, expect, it } from "vite-plus/test";
import { readTenantApiParams } from "@/lib/tenant-api-scope";

/**
 * `readTenantApiParams` is the pure presence policy behind
 * `resolveTenantApiScope` — the session-API sibling of `requireTenantContext`.
 * It encodes the read-API contract the four handlers under
 * `routes/api/t/:teamSlug/p/:projectSlug/runs/:runId/*` previously duplicated:
 *
 *  - `teamSlug`, `projectSlug`, `runId` are ALWAYS required.
 *  - `testResultId` is required only when the route declares it
 *    (`requireTestResultId: true`).
 *  - Any missing/empty required param yields `null`, which the impure wrapper
 *    maps to the leak-safe `404 { error: "Not found" }` (never 403).
 *
 * Splitting the policy out keeps it unit-testable without a Hono `Context` or
 * a live D1. If a future edit drops a param check or makes `testResultId`
 * unconditionally required, these tests fail.
 */

/** Build a `c.req.param`-style accessor from a plain record. */
function paramGetter(
  params: Record<string, string | undefined>,
): (name: string) => string | undefined {
  return (name) => params[name];
}

const FULL = {
  teamSlug: "acme",
  projectSlug: "web",
  runId: "run_123",
  testResultId: "tr_456",
};

describe("readTenantApiParams (run-scoped, no testResultId)", () => {
  it("returns the three core params with testResultId null", () => {
    const result = readTenantApiParams(paramGetter(FULL));
    expect(result).toEqual({
      teamSlug: "acme",
      projectSlug: "web",
      runId: "run_123",
      testResultId: null,
    });
  });

  it("ignores testResultId when the route doesn't declare it", () => {
    // Even though testResultId is present, it is not surfaced unless required.
    const result = readTenantApiParams(paramGetter(FULL), {});
    expect(result?.testResultId).toBeNull();
  });

  it.each(["teamSlug", "projectSlug", "runId"])(
    "returns null when %s is missing",
    (missing) => {
      const params = { ...FULL, [missing]: undefined };
      expect(readTenantApiParams(paramGetter(params))).toBeNull();
    },
  );

  it.each(["teamSlug", "projectSlug", "runId"])(
    "returns null when %s is empty string",
    (empty) => {
      const params = { ...FULL, [empty]: "" };
      expect(readTenantApiParams(paramGetter(params))).toBeNull();
    },
  );
});

describe("readTenantApiParams (testResultId required)", () => {
  const opts = { requireTestResultId: true } as const;

  it("returns all four params including testResultId", () => {
    const result = readTenantApiParams(paramGetter(FULL), opts);
    expect(result).toEqual({
      teamSlug: "acme",
      projectSlug: "web",
      runId: "run_123",
      testResultId: "tr_456",
    });
  });

  it("returns null when testResultId is missing", () => {
    const params = { ...FULL, testResultId: undefined };
    expect(readTenantApiParams(paramGetter(params), opts)).toBeNull();
  });

  it("returns null when testResultId is empty string", () => {
    const params = { ...FULL, testResultId: "" };
    expect(readTenantApiParams(paramGetter(params), opts)).toBeNull();
  });

  it("still requires the three core params", () => {
    const params = { ...FULL, runId: undefined };
    expect(readTenantApiParams(paramGetter(params), opts)).toBeNull();
  });
});
