import { describe, expect, it } from "vite-plus/test";
import {
  dedupeGroups,
  filterTests,
  groupKeyId,
  groupLabel,
  matchesStatusFilter,
  mergeGroupRows,
  parseTitleSegments,
  rawGroupKey,
  recommendedRank,
  worstStatusInGroup,
} from "@/lib/group-tests-by-file";
import type {
  RunProgressTest,
  RunProgressTestStatus,
} from "@/realtime/run-progress";

let idSeq = 0;
function t(
  file: string,
  status: RunProgressTestStatus,
  overrides: Partial<RunProgressTest> = {},
): RunProgressTest {
  idSeq += 1;
  return {
    id: `id_${idSeq}`,
    testId: `test_${idSeq}`,
    title: `test ${idSeq}`,
    projectName: null,
    file,
    status,
    durationMs: 0,
    retryCount: 0,
    shardIndex: null,
    ...overrides,
  };
}

describe("parseTitleSegments", () => {
  it("handles a bare test title (no file or describes)", () => {
    expect(parseTitleSegments("smoke test", "a.spec.ts", null)).toEqual({
      describeChain: [],
      testTitle: "smoke test",
    });
  });

  it("strips the file basename when it leads the title", () => {
    expect(
      parseTitleSegments("a.spec.ts > smoke test", "a.spec.ts", null),
    ).toEqual({ describeChain: [], testTitle: "smoke test" });
  });

  it("strips the file basename when file is a path and title uses only the basename", () => {
    expect(
      parseTitleSegments(
        "checkout.spec.ts > Checkout > pays",
        "e2e/checkout.spec.ts",
        null,
      ),
    ).toEqual({ describeChain: ["Checkout"], testTitle: "pays" });
  });

  it("strips a leading projectName before the file segment", () => {
    expect(
      parseTitleSegments(
        "chromium > flaky.spec.ts > Promo codes > validates",
        "flaky.spec.ts",
        "chromium",
      ),
    ).toEqual({ describeChain: ["Promo codes"], testTitle: "validates" });
  });

  it("returns the whole chain as describes when there's no test title following", () => {
    expect(parseTitleSegments("only", "a.spec.ts", null)).toEqual({
      describeChain: [],
      testTitle: "only",
    });
  });

  it("keeps nested describe blocks", () => {
    expect(
      parseTitleSegments(
        "flaky.spec.ts > Promo codes > Expired > blocks expired @fails",
        "flaky.spec.ts",
        null,
      ),
    ).toEqual({
      describeChain: ["Promo codes", "Expired"],
      testTitle: "blocks expired @fails",
    });
  });

  it("does not strip segments that coincidentally contain the basename", () => {
    expect(
      parseTitleSegments("not-a.spec.ts > title", "a.spec.ts", null),
    ).toEqual({
      describeChain: ["not-a.spec.ts"],
      testTitle: "title",
    });
  });
});

describe("worstStatusInGroup", () => {
  it("picks the worst bucket present, worst-first", () => {
    expect(
      worstStatusInGroup({ passed: 5, failed: 1, flaky: 2, skipped: 3 }),
    ).toBe("failed");
    expect(
      worstStatusInGroup({ passed: 5, failed: 0, flaky: 2, skipped: 3 }),
    ).toBe("flaky");
    expect(
      worstStatusInGroup({ passed: 5, failed: 0, flaky: 0, skipped: 3 }),
    ).toBe("passed");
  });

  it("ranks skipped below passed — skipped only wins when the group is all-skipped", () => {
    // Any real result outranks skipped: one pass + many skips reads as passed.
    expect(
      worstStatusInGroup({ passed: 1, failed: 0, flaky: 0, skipped: 9 }),
    ).toBe("passed");
    // Entirely skipped → skipped.
    expect(
      worstStatusInGroup({ passed: 0, failed: 0, flaky: 0, skipped: 3 }),
    ).toBe("skipped");
  });

  it("returns null when every bucket is zero (e.g. only queued rows)", () => {
    expect(
      worstStatusInGroup({ passed: 0, failed: 0, flaky: 0, skipped: 0 }),
    ).toBeNull();
  });
});

describe("filterTests", () => {
  const rows = [
    t("e2e/login.spec.ts", "failed", { title: "logs in with password" }),
    t("e2e/login.spec.ts", "passed", { title: "logs out" }),
    t("e2e/checkout.spec.ts", "flaky", { title: "applies a promo code" }),
    t("e2e/checkout.spec.ts", "timedout", { title: "charges the card" }),
    t("e2e/cart.spec.ts", "skipped", { title: "shows empty state" }),
  ];

  it("returns everything when status is `all` and search is empty", () => {
    expect(filterTests(rows, { search: "", statusFilter: "all" })).toHaveLength(
      5,
    );
  });

  it("filters by collapsed bucket — `failed` includes timedout, excludes flaky", () => {
    const failed = filterTests(rows, { search: "", statusFilter: "failed" });
    expect(failed.map((r) => r.title)).toEqual([
      "logs in with password",
      "charges the card",
    ]);
  });

  it("filters by `flaky` bucket", () => {
    const flaky = filterTests(rows, { search: "", statusFilter: "flaky" });
    expect(flaky.map((r) => r.title)).toEqual(["applies a promo code"]);
  });

  it("matches the needle against title (case-insensitive)", () => {
    const hits = filterTests(rows, { search: "PROMO", statusFilter: "all" });
    expect(hits.map((r) => r.title)).toEqual(["applies a promo code"]);
  });

  it("matches the needle against the file path", () => {
    const hits = filterTests(rows, { search: "checkout", statusFilter: "all" });
    expect(hits).toHaveLength(2);
    expect(hits.every((r) => r.file === "e2e/checkout.spec.ts")).toBe(true);
  });

  it("combines status filter AND search (intersection)", () => {
    const hits = filterTests(rows, {
      search: "login",
      statusFilter: "failed",
    });
    expect(hits.map((r) => r.title)).toEqual(["logs in with password"]);
  });

  it("ignores whitespace-only search", () => {
    expect(
      filterTests(rows, { search: "   ", statusFilter: "all" }),
    ).toHaveLength(5);
  });

  it("preserves input order", () => {
    const hits = filterTests(rows, { search: "", statusFilter: "all" });
    expect(hits.map((r) => r.title)).toEqual(rows.map((r) => r.title));
  });
});

// The group-key contract shared by the SERVER skeleton (`loadRunGroupSkeleton`'s
// `key`) and the CLIENT (identity + label + live-overlay routing). A divergence
// here silently mismatches a streamed row to the wrong header, so these pin it.
describe("rawGroupKey", () => {
  it("returns the raw file (empty string kept, never null since file is NOT NULL)", () => {
    expect(rawGroupKey(t("a/b.spec.ts", "passed"), "file")).toBe("a/b.spec.ts");
    expect(rawGroupKey(t("", "passed"), "file")).toBe("");
  });

  it("returns projectName or null for the project axis", () => {
    expect(
      rawGroupKey(t("f", "passed", { projectName: "chromium" }), "project"),
    ).toBe("chromium");
    expect(
      rawGroupKey(t("f", "passed", { projectName: null }), "project"),
    ).toBeNull();
  });

  it("stringifies shardIndex and maps a non-sharded row to null", () => {
    expect(rawGroupKey(t("f", "passed", { shardIndex: 3 }), "shard")).toBe("3");
    expect(
      rawGroupKey(t("f", "passed", { shardIndex: null }), "shard"),
    ).toBeNull();
  });
});

describe("groupKeyId", () => {
  it("passes a real key through and gives null a stable sentinel", () => {
    expect(groupKeyId("a.spec.ts")).toBe("a.spec.ts");
    // The sentinel can't collide with a real key (real keys are non-null here).
    expect(groupKeyId(null)).not.toBe("");
    expect(groupKeyId(null)).toBe(groupKeyId(null));
  });
});

describe("groupLabel", () => {
  it("renders each axis's fallback label for a null/empty key", () => {
    expect(groupLabel("file", "a.spec.ts")).toBe("a.spec.ts");
    expect(groupLabel("file", "")).toBe("Other");
    expect(groupLabel("project", "chromium")).toBe("chromium");
    expect(groupLabel("project", null)).toBe("default");
    expect(groupLabel("shard", "2")).toBe("Shard 2");
    expect(groupLabel("shard", null)).toBe("Unsharded");
  });
});

// The "Recommended" filter = the review-worthy tests (failed ∪ flaky). The
// client `matchesStatusFilter` (live overlay) must agree with the server's
// `statusFilterMembers`, and `recommendedRank` orders failed before flaky.
describe("matchesStatusFilter", () => {
  it("recommended matches the failed and flaky buckets (incl. timedout)", () => {
    for (const s of ["failed", "timedout", "flaky"] as const) {
      expect(matchesStatusFilter(s, "recommended")).toBe(true);
    }
    for (const s of ["passed", "skipped", "queued"] as const) {
      expect(matchesStatusFilter(s, "recommended")).toBe(false);
    }
  });

  it("a single-bucket filter matches only its own bucket", () => {
    expect(matchesStatusFilter("timedout", "failed")).toBe(true); // timedout ∈ failed
    expect(matchesStatusFilter("flaky", "failed")).toBe(false);
    expect(matchesStatusFilter("passed", "passed")).toBe(true);
  });
});

describe("filterTests (recommended)", () => {
  it("keeps only failed/flaky-bucket rows", () => {
    const rows = [
      t("a.spec.ts", "failed"),
      t("a.spec.ts", "timedout"),
      t("a.spec.ts", "flaky"),
      t("a.spec.ts", "passed"),
      t("a.spec.ts", "skipped"),
    ];
    const kept = filterTests(rows, { search: "", statusFilter: "recommended" });
    expect(kept.map((r) => r.status)).toEqual(["failed", "timedout", "flaky"]);
  });
});

describe("recommendedRank", () => {
  it("ranks the failed bucket ahead of flaky (and everything else)", () => {
    expect(recommendedRank("failed")).toBeLessThan(recommendedRank("flaky"));
    expect(recommendedRank("timedout")).toBeLessThan(recommendedRank("flaky"));
    expect(recommendedRank("failed")).toBe(recommendedRank("timedout"));
  });
});

// `mergeGroupRows` folds a group's server-paginated rows and its live overlay
// into the display list, ordered to match the server's page order — the exact
// cursor-coherence invariant that silently breaks infinite scroll if it drifts.
describe("mergeGroupRows", () => {
  const F = (
    id: string,
    status: RunProgressTestStatus,
    over: Partial<RunProgressTest> = {},
  ) => t("a.spec.ts", status, { id, ...over });

  it("orders fetched rows by id descending (matches the server (createdAt,id) cursor)", () => {
    const merged = mergeGroupRows(
      [F("id_a", "passed"), F("id_c", "passed"), F("id_b", "passed")],
      [],
      { search: "", statusFilter: "all" },
    );
    expect(merged.map((r) => r.id)).toEqual(["id_c", "id_b", "id_a"]);
  });

  it("merges the live overlay over a fetched row with the same id (live wins)", () => {
    const merged = mergeGroupRows(
      [F("id_1", "passed", { title: "old" })],
      [F("id_1", "failed", { title: "new" })],
      { search: "", statusFilter: "all" },
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      id: "id_1",
      status: "failed",
      title: "new",
    });
  });

  it("adds live rows absent from the fetched page", () => {
    const merged = mergeGroupRows(
      [F("id_1", "passed")],
      [F("id_2", "failed")],
      {
        search: "",
        statusFilter: "all",
      },
    );
    expect(merged.map((r) => r.id)).toEqual(["id_2", "id_1"]);
  });

  it("filters the live overlay to the active view (fetched is already server-filtered)", () => {
    const merged = mergeGroupRows(
      [],
      [F("id_2", "passed"), F("id_3", "failed")],
      { search: "", statusFilter: "failed" },
    );
    expect(merged.map((r) => r.id)).toEqual(["id_3"]);
  });

  it("recommended: failed-bucket rows sort before flaky, then id-descending", () => {
    const merged = mergeGroupRows(
      [
        F("id_1", "flaky"),
        F("id_2", "failed"),
        F("id_3", "flaky"),
        F("id_4", "timedout"),
      ],
      [],
      { search: "", statusFilter: "recommended" },
    );
    expect(merged.map((r) => r.id)).toEqual(["id_4", "id_2", "id_3", "id_1"]);
    expect(merged.map((r) => r.status)).toEqual([
      "timedout",
      "failed",
      "flaky",
      "flaky",
    ]);
  });
});

// `dedupeGroups` flattens paginated skeleton pages into one worst-first header
// list, deduping by group identity so a rank-shifted group can't render twice.
describe("dedupeGroups", () => {
  const page = (...keys: (string | null)[]) => ({
    groups: keys.map((key) => ({ key })),
  });

  it("flattens pages in order, deduping by group key (first occurrence wins)", () => {
    const out = dedupeGroups([page("a", "b"), page("b", "c")]);
    expect(out.map((g) => g.key)).toEqual(["a", "b", "c"]);
  });

  it("treats the null fallback key as one identity, distinct from real keys", () => {
    const out = dedupeGroups([page(null, "a"), page(null)]);
    expect(out.map((g) => g.key)).toEqual([null, "a"]);
  });

  it("returns an empty list for no pages", () => {
    expect(dedupeGroups([])).toEqual([]);
  });
});
