// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

/**
 * Pagination / keyset-cursor integration — split out of the former monolithic
 * `pg-integration.test.ts` (see docs/worklog/2026-07-11-split-pg-integration-tests.md).
 * This file owns the run-group skeleton + row-page domain: worst-first file/
 * shard/project grouping, status/search/recommended filters, and the keyset
 * cursor's numeric-order + NULLS-LAST-fallback regressions — executed against
 * the real schema (pglite by default, real node-postgres under PG_TEST_URL).
 * See `./harness.ts` for the shared hoisted-mock boot dance.
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

// Neither loader broadcasts, but mock for consistency with the rest of this
// directory (harmless if unused).
vi.mock("@/realtime/publish", () => ({
  broadcastRunRoom: () => Promise.resolve(),
  broadcastProjectRoom: () => Promise.resolve(),
}));

const { resetTables } = await import("./harness");
const { makeTenantScope } = await import("@/lib/scope");
const { loadRunGroupSkeleton, encodeGroupCursor } =
  await import("@/lib/runs/groups-page");
const { loadRunResultsPage } = await import("@/lib/runs/results-page");
const { testResults } = await import("../../../db/schema");
const { eq } = await import("void/_db");

beforeAll(async () => {
  await resetTables(h.client, [testResults]);
});

afterAll(async () => {
  await h.client.close();
});

describe("run-group skeleton (grouped read)", () => {
  const scope = makeTenantScope({
    teamId: "t-grp",
    projectId: "p-grp",
    teamSlug: "grp",
    projectSlug: "grp",
  });
  const RUN = "run-grp";
  const SHARD_RUN = "run-grp-shard";
  const REC_RUN = "run-grp-rec";
  // Regression fixtures for the keyset-cursor fix (native numeric compare +
  // NULLS-LAST-consistent NULL fallback group) — see run-groups-page.ts.
  const SHARD_NUM_RUN = "run-grp-shard-num";
  const SHARD_NULL_TIER_RUN = "run-grp-shard-nulltier";
  const PROJECT_EMPTY_RUN = "run-grp-project-empty";
  const T0 = 1_700_100_000;

  type SeedRow = {
    testId: string;
    file: string;
    status: string;
    shardIndex?: number | null;
    projectName?: string | null;
  };

  async function seed(runId: string, rows: SeedRow[]) {
    await h.db.delete(testResults).where(eq(testResults.runId, runId));
    await h.db.insert(testResults).values(
      rows.map((r, i) => ({
        id: `${runId}-${r.testId}`,
        projectId: scope.projectId,
        runId,
        testId: r.testId,
        title: `test ${r.testId}`,
        file: r.file,
        projectName: r.projectName ?? null,
        status: r.status,
        durationMs: 0,
        retryCount: 0,
        shardIndex: r.shardIndex ?? null,
        createdAt: T0 + i,
        updatedAt: T0 + i,
      })),
    );
  }

  beforeAll(async () => {
    // a: 2 failed + 1 passed (sev 8, total 3)
    // b: 1 failed + 1 timedout + 3 passed (failed BUCKET = 2 → sev 8, total 5)
    // c: 1 flaky + 2 passed (sev 2)   d: 2 passed (sev 0)   e: 1 skipped + 1 passed (sev 0)
    await seed(RUN, [
      { testId: "a1", file: "a.spec.ts", status: "failed" },
      { testId: "a2", file: "a.spec.ts", status: "failed" },
      { testId: "a3", file: "a.spec.ts", status: "passed" },
      { testId: "b1", file: "b.spec.ts", status: "failed" },
      { testId: "b2", file: "b.spec.ts", status: "timedout" },
      { testId: "b3", file: "b.spec.ts", status: "passed" },
      { testId: "b4", file: "b.spec.ts", status: "passed" },
      { testId: "b5", file: "b.spec.ts", status: "passed" },
      { testId: "c1", file: "c.spec.ts", status: "flaky" },
      { testId: "c2", file: "c.spec.ts", status: "passed" },
      { testId: "c3", file: "c.spec.ts", status: "passed" },
      { testId: "d1", file: "d.spec.ts", status: "passed" },
      { testId: "d2", file: "d.spec.ts", status: "passed" },
      { testId: "e1", file: "e.spec.ts", status: "skipped" },
      { testId: "e2", file: "e.spec.ts", status: "passed" },
    ]);
    await seed(SHARD_RUN, [
      { testId: "s1", file: "x.spec.ts", status: "failed", shardIndex: 1 },
      { testId: "s2", file: "x.spec.ts", status: "passed", shardIndex: 1 },
      { testId: "s3", file: "y.spec.ts", status: "passed", shardIndex: null },
      { testId: "s4", file: "y.spec.ts", status: "passed", shardIndex: null },
    ]);
    // 10 single-row shard groups, all passed (one severity-0 tier). Native
    // numeric order is 1, 2, …, 10; a text-cast cursor would instead sort
    // "10" before "2" and — worse — drop it entirely once the cursor passes
    // "9" (since "10" < "9" lexicographically).
    await seed(
      SHARD_NUM_RUN,
      Array.from({ length: 10 }, (_, i) => ({
        testId: `n${i + 1}`,
        file: "n.spec.ts",
        status: "passed",
        shardIndex: i + 1,
      })),
    );
    // shard 1/2/null all carry a failed row (sev 4, same tier); shard 3 is
    // all-passed (sev 0, next tier). Within the sev-4 tier, native asc order
    // (NULLS LAST) is 1, 2, null.
    await seed(SHARD_NULL_TIER_RUN, [
      { testId: "u1", file: "u.spec.ts", status: "failed", shardIndex: 1 },
      { testId: "u2", file: "u.spec.ts", status: "failed", shardIndex: 2 },
      { testId: "u3", file: "u.spec.ts", status: "failed", shardIndex: null },
      { testId: "u4", file: "u.spec.ts", status: "passed", shardIndex: 3 },
    ]);
    // Empty-string project names are Playwright's default and sort before named
    // projects. They must not be decoded as the NULL fallback cursor.
    await seed(PROJECT_EMPTY_RUN, [
      {
        testId: "pe0",
        file: "project.spec.ts",
        status: "failed",
        projectName: "",
      },
      {
        testId: "pea",
        file: "project.spec.ts",
        status: "failed",
        projectName: "alpha",
      },
      {
        testId: "peb",
        file: "project.spec.ts",
        status: "failed",
        projectName: "beta",
      },
    ]);
    // One file with failed/flaky rows INTERLEAVED by insert time (createdAt), so
    // a pure (createdAt, id) page order would split failed rows across pages.
    // The "recommended" bucket rank must pull all failed rows ahead of flaky.
    await seed(REC_RUN, [
      { testId: "rec1", file: "big.spec.ts", status: "failed" }, // T0+0
      { testId: "rec2", file: "big.spec.ts", status: "flaky" }, // T0+1
      { testId: "rec3", file: "big.spec.ts", status: "failed" }, // T0+2
      { testId: "rec4", file: "big.spec.ts", status: "flaky" }, // T0+3
      { testId: "rec5", file: "big.spec.ts", status: "failed" }, // T0+4
    ]);
  });

  it("groups by file worst-first with per-bucket counts (timedout ∈ failed) + auto-expand flags", async () => {
    const skel = await loadRunGroupSkeleton(scope, RUN, {
      groupBy: "file",
      status: null,
      search: null,
      cursor: null,
      limit: 50,
      skipOwnershipCheck: true,
    });
    if (!skel) throw new Error("expected a skeleton");
    // sev desc, key asc: a(8) b(8) c(2) d(0) e(0). int8 counts come back as
    // JS numbers (numericSql) — the assertions on numeric equality pin that.
    expect(skel.groups.map((g) => g.key)).toEqual([
      "a.spec.ts",
      "b.spec.ts",
      "c.spec.ts",
      "d.spec.ts",
      "e.spec.ts",
    ]);
    expect(skel.groups[0]).toMatchObject({
      key: "a.spec.ts",
      total: 3,
      failed: 2,
      flaky: 0,
      passed: 1,
      skipped: 0,
      expandedByDefault: true,
    });
    expect(skel.groups[1]).toMatchObject({
      key: "b.spec.ts",
      total: 5,
      failed: 2, // 1 failed + 1 timedout
      passed: 3,
      expandedByDefault: true,
    });
    expect(skel.groups[2]).toMatchObject({
      key: "c.spec.ts",
      flaky: 1,
      passed: 2,
      expandedByDefault: true,
    });
    expect(skel.groups[3]).toMatchObject({
      key: "d.spec.ts",
      expandedByDefault: false,
    });
    expect(skel.groups[4]).toMatchObject({
      key: "e.spec.ts",
      skipped: 1,
      expandedByDefault: false,
    });
    // Page carries failing groups → the client may latch auto-expand.
    expect(skel.hasFailingGroup).toBe(true);
  });

  it("status filter narrows to failing groups (failed bucket only)", async () => {
    const skel = await loadRunGroupSkeleton(scope, RUN, {
      groupBy: "file",
      status: "failed",
      search: null,
      cursor: null,
      limit: 50,
      skipOwnershipCheck: true,
    });
    if (!skel) throw new Error("expected a skeleton");
    expect(skel.groups.map((g) => g.key)).toEqual(["a.spec.ts", "b.spec.ts"]);
    expect(skel.groups[0]).toMatchObject({ total: 2, failed: 2, passed: 0 });
    expect(skel.groups[1]).toMatchObject({ total: 2, failed: 2, passed: 0 });
  });

  it("search filter narrows to matching files (ILIKE title/file)", async () => {
    const skel = await loadRunGroupSkeleton(scope, RUN, {
      groupBy: "file",
      status: null,
      search: "c.spec",
      cursor: null,
      limit: 50,
      skipOwnershipCheck: true,
    });
    if (!skel) throw new Error("expected a skeleton");
    expect(skel.groups.map((g) => g.key)).toEqual(["c.spec.ts"]);
  });

  it("recommended filter = failed ∪ flaky groups, worst-first", async () => {
    const skel = await loadRunGroupSkeleton(scope, RUN, {
      groupBy: "file",
      status: "recommended",
      search: null,
      cursor: null,
      limit: 50,
      skipOwnershipCheck: true,
    });
    if (!skel) throw new Error("expected a skeleton");
    // a (2 failed, sev 8), b (2 failed, sev 8), c (1 flaky, sev 2); d/e drop out
    // (no failed/flaky). Counts cover only the failed/flaky rows.
    expect(skel.groups.map((g) => g.key)).toEqual([
      "a.spec.ts",
      "b.spec.ts",
      "c.spec.ts",
    ]);
    expect(skel.groups[0]).toMatchObject({ failed: 2, total: 2 });
    expect(skel.groups[2]).toMatchObject({
      key: "c.spec.ts",
      flaky: 1,
      total: 1,
    });

    // A recommended group's row page returns only its failed+flaky rows.
    const rows = await loadRunResultsPage(scope, RUN, {
      cursor: null,
      limit: 200,
      status: null,
      statusBucket: "recommended",
      group: { axis: "file", key: "b.spec.ts" },
      skipOwnershipCheck: true,
    });
    if (!rows) throw new Error("expected a page");
    expect(rows.results).toHaveLength(2); // failed + timedout (both failed bucket)
    expect(
      rows.results.every(
        (r) => r.status === "failed" || r.status === "timedout",
      ),
    ).toBe(true);
  });

  it("paginates group headers worst-first via the cursor", async () => {
    // limit 2 → page 1 = the two worst (a, b — both sev 8, key asc), nextCursor set.
    const page1 = await loadRunGroupSkeleton(scope, RUN, {
      groupBy: "file",
      status: null,
      search: null,
      cursor: null,
      limit: 2,
      skipOwnershipCheck: true,
    });
    if (!page1) throw new Error("expected page 1");
    expect(page1.groups.map((g) => g.key)).toEqual(["a.spec.ts", "b.spec.ts"]);
    expect(page1.nextCursor).not.toBeNull();

    // page 2 continues after the cursor: c (sev 2), then d, e (sev 0, key asc).
    const page2 = await loadRunGroupSkeleton(scope, RUN, {
      groupBy: "file",
      status: null,
      search: null,
      cursor: page1.nextCursor,
      limit: 2,
      skipOwnershipCheck: true,
    });
    if (!page2) throw new Error("expected page 2");
    expect(page2.groups.map((g) => g.key)).toEqual(["c.spec.ts", "d.spec.ts"]);
    // c had failures on page 1's side, but as a later page it must NOT be
    // force-expanded (fallback only applies to the first page).
    expect(page2.groups.every((g) => !g.expandedByDefault)).toBe(true);
    // c.spec.ts (flaky) is on this page → hasFailingGroup true here…
    expect(page2.hasFailingGroup).toBe(true);

    const page3 = await loadRunGroupSkeleton(scope, RUN, {
      groupBy: "file",
      status: null,
      search: null,
      cursor: page2.nextCursor,
      limit: 2,
      skipOwnershipCheck: true,
    });
    if (!page3) throw new Error("expected page 3");
    expect(page3.groups.map((g) => g.key)).toEqual(["e.spec.ts"]);
    expect(page3.nextCursor).toBeNull();
    // …but e.spec.ts is all passed/skipped → no failing group on the last page.
    expect(page3.hasFailingGroup).toBe(false);
  });

  it("recommended row pages order failed-before-flaky across page boundaries", async () => {
    // big.spec.ts interleaves failed/flaky by createdAt; a pure (createdAt, id)
    // order would put page 2's older failed rows below page 1's newer flaky rows.
    // The recommended bucket rank + ranked cursor keep all failed rows first.
    const acc: { testId: string; status: string }[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 5; i++) {
      const p = await loadRunResultsPage(scope, REC_RUN, {
        cursor,
        limit: 2,
        status: null,
        statusBucket: "recommended",
        group: { axis: "file", key: "big.spec.ts" },
        skipOwnershipCheck: true,
      });
      if (!p) throw new Error("expected a page");
      acc.push(
        ...p.results.map((r) => ({ testId: r.testId, status: r.status })),
      );
      if (!p.nextCursor) break;
      cursor = p.nextCursor;
    }
    // All 5 rows returned once, failed bucket first (id desc within a rank).
    expect(acc.map((r) => r.testId)).toEqual([
      "rec5",
      "rec3",
      "rec1",
      "rec4",
      "rec2",
    ]);
    expect(acc.map((r) => r.status)).toEqual([
      "failed",
      "failed",
      "failed",
      "flaky",
      "flaky",
    ]);
  });

  it("loadRunResultsPage restricts to one file group", async () => {
    const page = await loadRunResultsPage(scope, RUN, {
      cursor: null,
      limit: 200,
      status: null,
      group: { axis: "file", key: "a.spec.ts" },
      skipOwnershipCheck: true,
    });
    if (!page) throw new Error("expected a page");
    expect(page.results).toHaveLength(3);
    expect(new Set(page.results.map((r) => r.file))).toEqual(
      new Set(["a.spec.ts"]),
    );
  });

  it("groups by shard incl. the unsharded (null-key) fallback + filters rows by null key", async () => {
    const skel = await loadRunGroupSkeleton(scope, SHARD_RUN, {
      groupBy: "shard",
      status: null,
      search: null,
      cursor: null,
      limit: 50,
      skipOwnershipCheck: true,
    });
    if (!skel) throw new Error("expected a skeleton");
    // shard 1 has a failure (sev 4) → first; unsharded (null) sev 0 → second.
    expect(skel.groups.map((g) => g.key)).toEqual(["1", null]);
    expect(skel.groups[0]).toMatchObject({ key: "1", failed: 1, total: 2 });
    expect(skel.groups[1]).toMatchObject({ key: null, passed: 2, total: 2 });

    const nullPage = await loadRunResultsPage(scope, SHARD_RUN, {
      cursor: null,
      limit: 200,
      status: null,
      group: { axis: "shard", key: null },
      skipOwnershipCheck: true,
    });
    if (!nullPage) throw new Error("expected a page");
    expect(nullPage.results).toHaveLength(2);
    expect(nullPage.results.every((r) => r.shardIndex === null)).toBe(true);
  });

  it("keyset cursor on the numeric shard axis follows native numeric order (regression: a text cursor would drop shard 10 after a cursor at shard 9)", async () => {
    const page1 = await loadRunGroupSkeleton(scope, SHARD_NUM_RUN, {
      groupBy: "shard",
      status: null,
      search: null,
      cursor: null,
      limit: 9,
      skipOwnershipCheck: true,
    });
    if (!page1) throw new Error("expected page 1");
    expect(page1.groups.map((g) => g.key)).toEqual(
      Array.from({ length: 9 }, (_, i) => String(i + 1)),
    );
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await loadRunGroupSkeleton(scope, SHARD_NUM_RUN, {
      groupBy: "shard",
      status: null,
      search: null,
      cursor: page1.nextCursor,
      limit: 9,
      skipOwnershipCheck: true,
    });
    if (!page2) throw new Error("expected page 2");
    // Under the old `::text` cast, "10" < "9" lexicographically, so shard 10
    // would fail the HAVING filter and vanish instead of appearing here.
    expect(page2.groups.map((g) => g.key)).toEqual(["10"]);
    expect(page2.nextCursor).toBeNull();
  });

  it("keyset cursor keeps the NULL shard fallback group visible after non-null keys in the same severity tier", async () => {
    const page1 = await loadRunGroupSkeleton(scope, SHARD_NULL_TIER_RUN, {
      groupBy: "shard",
      status: null,
      search: null,
      cursor: null,
      limit: 2,
      skipOwnershipCheck: true,
    });
    if (!page1) throw new Error("expected page 1");
    expect(page1.groups.map((g) => g.key)).toEqual(["1", "2"]);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await loadRunGroupSkeleton(scope, SHARD_NULL_TIER_RUN, {
      groupBy: "shard",
      status: null,
      search: null,
      cursor: page1.nextCursor,
      limit: 2,
      skipOwnershipCheck: true,
    });
    if (!page2) throw new Error("expected page 2");
    // The null fallback group is still in the severity-4 tier (it has a
    // failed row too) and must survive the page boundary: sorted after
    // "1"/"2" (NULLS LAST) and before the severity-0 tier's shard "3".
    expect(page2.groups.map((g) => g.key)).toEqual([null, "3"]);
    expect(page2.nextCursor).toBeNull();
  });

  it("keyset cursor sitting on the NULL group only continues into lower-severity tiers, without duplicating the already-emitted tier", async () => {
    const cursorAtNullGroup = encodeGroupCursor(4, null);
    const page = await loadRunGroupSkeleton(scope, SHARD_NULL_TIER_RUN, {
      groupBy: "shard",
      status: null,
      search: null,
      cursor: cursorAtNullGroup,
      limit: 50,
      skipOwnershipCheck: true,
    });
    if (!page) throw new Error("expected a page");
    // Only the lower-severity tier's shard "3" continues; "1"/"2" (same tier
    // as the cursor, already emitted ahead of the null group) must not
    // reappear.
    expect(page.groups.map((g) => g.key)).toEqual(["3"]);
    expect(page.nextCursor).toBeNull();
  });

  it("keeps named project groups after an empty-string project cursor", async () => {
    const page1 = await loadRunGroupSkeleton(scope, PROJECT_EMPTY_RUN, {
      groupBy: "project",
      status: null,
      search: null,
      cursor: null,
      limit: 1,
      skipOwnershipCheck: true,
    });
    if (!page1) throw new Error("expected page 1");
    expect(page1.groups.map((g) => g.key)).toEqual([""]);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await loadRunGroupSkeleton(scope, PROJECT_EMPTY_RUN, {
      groupBy: "project",
      status: null,
      search: null,
      cursor: page1.nextCursor,
      limit: 10,
      skipOwnershipCheck: true,
    });
    if (!page2) throw new Error("expected page 2");
    expect(page2.groups.map((g) => g.key)).toEqual(["alpha", "beta"]);
  });

  it("groups by project into the null-key fallback when projectName is null", async () => {
    const skel = await loadRunGroupSkeleton(scope, RUN, {
      groupBy: "project",
      status: null,
      search: null,
      cursor: null,
      limit: 50,
      skipOwnershipCheck: true,
    });
    if (!skel) throw new Error("expected a skeleton");
    expect(skel.groups).toHaveLength(1);
    expect(skel.groups[0]?.key).toBeNull();
    expect(skel.groups[0]?.total).toBe(15);
  });
});
