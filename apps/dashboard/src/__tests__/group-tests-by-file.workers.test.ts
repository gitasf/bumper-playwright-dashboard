import { describe, expect, it } from "vite-plus/test";
import {
  countByStatusGroup,
  filterTests,
  groupAndSortTests,
  parseTitleSegments,
  selectDefaultExpandedKeys,
  severityOf,
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

describe("severityOf", () => {
  it("orders worst-first: failed < timedout < flaky < queued < skipped < passed", () => {
    const order = [
      "failed",
      "timedout",
      "flaky",
      "queued",
      "skipped",
      "passed",
    ];
    for (let i = 1; i < order.length; i += 1) {
      expect(severityOf(order[i - 1])).toBeLessThan(severityOf(order[i]));
    }
  });

  it("pins the live-only `queued` state between flaky and skipped", () => {
    expect(severityOf("flaky")).toBeLessThan(severityOf("queued"));
    expect(severityOf("queued")).toBeLessThan(severityOf("skipped"));
  });
});

describe("countByStatusGroup", () => {
  it("counts into four buckets and collapses timedout→failed / interrupted→flaky", () => {
    expect(
      countByStatusGroup([
        t("a.spec.ts", "passed"),
        t("a.spec.ts", "passed"),
        t("a.spec.ts", "failed"),
        t("a.spec.ts", "timedout"),
        t("a.spec.ts", "flaky"),
        t("a.spec.ts", "interrupted"),
        t("a.spec.ts", "skipped"),
      ]),
    ).toEqual({ passed: 2, failed: 2, flaky: 2, skipped: 1 });
  });

  it("never leaves a bucket undefined", () => {
    expect(countByStatusGroup([])).toEqual({
      passed: 0,
      failed: 0,
      flaky: 0,
      skipped: 0,
    });
  });

  it("excludes `queued` (in-flight placeholder) from all four chips", () => {
    // queued rows must NOT inflate any chip — the Passed chip should stay at 0
    // for a run where every test is still pending execution.
    expect(countByStatusGroup([t("a.spec.ts", "queued")])).toEqual({
      passed: 0,
      failed: 0,
      flaky: 0,
      skipped: 0,
    });
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

describe("groupAndSortTests", () => {
  it("groups by file and orders groups worst-first by aggregate damage", () => {
    // checkout has 2 failures (score 8); login has 1 failure (4); cart all-pass (0).
    const { groups } = groupAndSortTests(
      [
        t("cart.spec.ts", "passed"),
        t("login.spec.ts", "failed"),
        t("login.spec.ts", "passed"),
        t("checkout.spec.ts", "failed"),
        t("checkout.spec.ts", "failed"),
      ],
      { search: "", statusFilter: "all", groupBy: "file" },
    );
    expect(groups.map(([k]) => k)).toEqual([
      "checkout.spec.ts",
      "login.spec.ts",
      "cart.spec.ts",
    ]);
  });

  it("groups by Playwright project, falling back to `default` for null", () => {
    const { groups } = groupAndSortTests(
      [
        t("a.spec.ts", "passed", { projectName: "chromium" }),
        t("a.spec.ts", "failed", { projectName: "firefox" }),
        t("a.spec.ts", "passed", { projectName: null }),
      ],
      { search: "", statusFilter: "all", groupBy: "project" },
    );
    const keys = groups.map(([k]) => k);
    // firefox has the failure so it sorts first; default + chromium follow.
    expect(keys[0]).toBe("firefox");
    expect(keys).toContain("chromium");
    expect(keys).toContain("default");
  });

  it("falls back to `Other` for an empty file path", () => {
    const { groups } = groupAndSortTests([t("", "passed")], {
      search: "",
      statusFilter: "all",
      groupBy: "file",
    });
    expect(groups.map(([k]) => k)).toEqual(["Other"]);
  });

  it("sorts rows within a group worst-status-first", () => {
    const { groups } = groupAndSortTests(
      [
        t("a.spec.ts", "passed", { title: "p" }),
        t("a.spec.ts", "failed", { title: "f" }),
        t("a.spec.ts", "skipped", { title: "s" }),
        t("a.spec.ts", "flaky", { title: "fl" }),
      ],
      { search: "", statusFilter: "all", groupBy: "file" },
    );
    expect(groups[0][1].map((r) => r.title)).toEqual(["f", "fl", "s", "p"]);
  });

  it("counts over the unfiltered input even when a status filter is active", () => {
    const { statusCounts, groups } = groupAndSortTests(
      [t("a.spec.ts", "failed"), t("a.spec.ts", "passed")],
      { search: "", statusFilter: "failed", groupBy: "file" },
    );
    // Only the failure survives grouping…
    expect(groups[0][1]).toHaveLength(1);
    // …but the chip counts still reflect both rows.
    expect(statusCounts).toEqual({
      passed: 1,
      failed: 1,
      flaky: 0,
      skipped: 0,
    });
  });

  it("does not mutate the input array", () => {
    const input = [t("a.spec.ts", "passed"), t("a.spec.ts", "failed")];
    const snapshot = input.map((r) => r.id);
    groupAndSortTests(input, {
      search: "",
      statusFilter: "all",
      groupBy: "file",
    });
    expect(input.map((r) => r.id)).toEqual(snapshot);
  });
});

describe("selectDefaultExpandedKeys", () => {
  it("expands any of the worst-six groups containing a failed or flaky test", () => {
    const groups: [string, RunProgressTest[]][] = [
      ["a", [t("a.spec.ts", "failed")]],
      ["b", [t("b.spec.ts", "passed")]],
      ["c", [t("c.spec.ts", "flaky")]],
    ];
    expect(selectDefaultExpandedKeys(groups)).toEqual(new Set(["a", "c"]));
  });

  it("only considers the worst six groups", () => {
    const groups: [string, RunProgressTest[]][] = Array.from(
      { length: 8 },
      (_, i): [string, RunProgressTest[]] => [
        `g${i}`,
        [t(`g${i}.spec.ts`, "failed")],
      ],
    );
    const expanded = selectDefaultExpandedKeys(groups);
    expect(expanded.size).toBe(6);
    expect(expanded.has("g6")).toBe(false);
    expect(expanded.has("g7")).toBe(false);
  });

  it("falls back to the single worst group when nothing failed or flaked", () => {
    const groups: [string, RunProgressTest[]][] = [
      ["first", [t("a.spec.ts", "passed")]],
      ["second", [t("b.spec.ts", "skipped")]],
    ];
    expect(selectDefaultExpandedKeys(groups)).toEqual(new Set(["first"]));
  });

  it("returns an empty set for no groups", () => {
    expect(selectDefaultExpandedKeys([])).toEqual(new Set());
  });
});
