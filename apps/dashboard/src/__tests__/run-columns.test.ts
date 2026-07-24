// @vitest-environment node
import { describe, expect, it } from "vite-plus/test";
import { getTableConfig } from "void/schema-pg";
import { runs } from "../../db/schema";
import { RUN_PUBLIC_COLUMNS } from "@/lib/runs/columns";

/**
 * `RUN_PUBLIC_COLUMNS` is the allowlist of `runs` columns safe to serialize into
 * SSR page props. These guard the security contract: `idempotencyKey` (the
 * write-reopen credential) must never be projected, AND every OTHER column must
 * be — so adding a new secret column to `runs` forces a conscious decision here
 * (the coverage test fails until the new column is either included or added to
 * the excluded set below) rather than silently re-leaking via a bare `.select()`.
 */
describe("RUN_PUBLIC_COLUMNS", () => {
  // The columns deliberately withheld from client props (see run-columns.ts):
  // `idempotencyKey` is the write-reopen credential; `githubCheckClaimedAt` is
  // server-side check-run claim-coordination state no page reads.
  const EXCLUDED = new Set(["idempotencyKey", "githubCheckClaimedAt"]);

  it("never exposes idempotencyKey", () => {
    expect(Object.keys(RUN_PUBLIC_COLUMNS)).not.toContain("idempotencyKey");
  });

  it("projects exactly the runs columns minus the excluded set", () => {
    const allColumns = getTableConfig(runs).columns.map((c) => c.name);
    const projected = new Set(Object.keys(RUN_PUBLIC_COLUMNS));

    // Every non-excluded column is projected (a new column can't silently vanish).
    const missing = allColumns.filter(
      (n) => !EXCLUDED.has(n) && !projected.has(n),
    );
    expect(missing).toEqual([]);

    // Nothing projected that isn't a real column, and nothing excluded is projected.
    const stray = [...projected].filter((n) => !allColumns.includes(n));
    expect(stray).toEqual([]);
    for (const ex of EXCLUDED) expect(projected.has(ex)).toBe(false);
  });
});
