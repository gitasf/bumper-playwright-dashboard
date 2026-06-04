import { describe, expect, it } from "vite-plus/test";
import {
  latestPerTestRn,
  latestPerTestValue,
  statusCounter,
} from "@/lib/analytics/per-test";

/**
 * `latestPerTestRn` / `statusCounter` concentrate the two error-prone idioms
 * three analytics loaders (tests / slowest-tests / flaky) used to re-inline:
 *
 *   1. the `row_number() over (partition by … order by … desc)` window that
 *      picks the LATEST row per test, and
 *   2. the per-test `sum(case when status = … then 1 else 0 end)` counters,
 *      with ONE canonical definition of "fail" (`status in ('failed','timedout')`)
 *      and "flaky" so flaky-vs-failed semantics live in a single place.
 *
 * Both emit raw SQL (`sql.raw`) — identifiers and status literals are not bound
 * params, for the same D1 text-affinity reason `bucketExpr` inlines its
 * divisors. Under the void/db stub `sql.raw(s)` records `s` in `strings`, so we
 * read the rendered text back without a real database. These assertions pin the
 * emitted SQL byte-for-byte against what the loaders previously inlined, so a
 * maintainer changing the rank/counter shape edits one place and a drift fails
 * loudly here.
 */

/** Read the rendered SQL text off a `sql.raw(...)` fragment from the stub. */
function rawText(expr: unknown): string {
  const chunk = expr as { strings: unknown; args: readonly unknown[] };
  const s = chunk.strings;
  return Array.isArray(s) ? s.join("") : String(s);
}

/** A `sql.raw(...)` fragment carries no bound params. */
function noBoundArgs(expr: unknown): void {
  const chunk = expr as { args: readonly unknown[] };
  expect(chunk.args).toHaveLength(0);
}

describe("latestPerTestRn", () => {
  it("defaults to the tr.-qualified columns the flaky/tests loaders partition by", () => {
    // flaky.server.ts loadSparklinesAndMeta / loadRecentFailures used `rn`.
    expect(rawText(latestPerTestRn("rn"))).toBe(
      'row_number() over (partition by tr."testId" order by tr."createdAt" desc) as rn',
    );
  });

  it("threads a quoted alias verbatim (tests.server.ts runAggregateQuery)", () => {
    expect(rawText(latestPerTestRn(`"rnTime"`))).toBe(
      'row_number() over (partition by tr."testId" order by tr."createdAt" desc) as "rnTime"',
    );
  });

  it("threads bare CTE-alias columns (slowest-tests ranks over the `filtered` CTE)", () => {
    // slowest-tests partitions by the projected `"testId"` / `"createdAt"`
    // columns of its inner `filtered` CTE, not the `tr.`-qualified originals.
    expect(
      rawText(
        latestPerTestRn(`"rnTime"`, {
          testIdCol: `"testId"`,
          orderByCol: `"createdAt"`,
        }),
      ),
    ).toBe(
      'row_number() over (partition by "testId" order by "createdAt" desc) as "rnTime"',
    );
  });

  it("binds nothing — identifiers are inline raw SQL, never params", () => {
    noBoundArgs(latestPerTestRn("rn"));
    noBoundArgs(
      latestPerTestRn(`"rnTime"`, {
        testIdCol: `"testId"`,
        orderByCol: `"createdAt"`,
      }),
    );
  });

  it("orders DESC so rn = 1 is the most recent result", () => {
    expect(rawText(latestPerTestRn("rn"))).toContain("order by");
    expect(rawText(latestPerTestRn("rn"))).toContain("desc) as rn");
  });
});

describe("latestPerTestValue", () => {
  it('reads a bare column at the latest row, gating on the default "rnTime" rank', () => {
    // The reader half that pairs with latestPerTestRn(`"rnTime"`); tests +
    // slowest-tests both project the latest title/file this way.
    expect(rawText(latestPerTestValue("title"))).toBe(
      `max(case when "rnTime" = 1 then title end)`,
    );
  });

  it("appends `as <alias>` when given an alias", () => {
    expect(rawText(latestPerTestValue("title", { alias: "title" }))).toBe(
      `max(case when "rnTime" = 1 then title end) as title`,
    );
    expect(
      rawText(latestPerTestValue(`"runId"`, { alias: `"latestRunId"` })),
    ).toBe(`max(case when "rnTime" = 1 then "runId" end) as "latestRunId"`);
  });

  it("threads a quoted column identifier verbatim", () => {
    expect(
      rawText(
        latestPerTestValue(`"testResultId"`, { alias: `"latestTestResultId"` }),
      ),
    ).toBe(
      `max(case when "rnTime" = 1 then "testResultId" end) as "latestTestResultId"`,
    );
  });

  it("gates on a custom rank column when asked", () => {
    expect(rawText(latestPerTestValue("status", { rnCol: "rn" }))).toBe(
      "max(case when rn = 1 then status end)",
    );
  });

  it("binds nothing — column + alias are inline raw SQL, never params", () => {
    noBoundArgs(latestPerTestValue("title"));
    noBoundArgs(latestPerTestValue(`"runId"`, { alias: `"latestRunId"` }));
  });

  it("matches, byte-for-byte, the latest-row picks the loaders previously inlined", () => {
    // The exact strings from tests.server.ts:243-247 and slowest-tests.server.ts:185-188.
    expect(rawText(latestPerTestValue("title", { alias: "title" }))).toBe(
      `max(case when "rnTime" = 1 then title end) as title`,
    );
    expect(rawText(latestPerTestValue("file", { alias: "file" }))).toBe(
      `max(case when "rnTime" = 1 then file end) as file`,
    );
    expect(
      rawText(latestPerTestValue("status", { alias: `"latestStatus"` })),
    ).toBe(`max(case when "rnTime" = 1 then status end) as "latestStatus"`);
    expect(
      rawText(latestPerTestValue(`"runId"`, { alias: `"latestRunId"` })),
    ).toBe(`max(case when "rnTime" = 1 then "runId" end) as "latestRunId"`);
    expect(
      rawText(
        latestPerTestValue(`"testResultId"`, { alias: `"latestTestResultId"` }),
      ),
    ).toBe(
      `max(case when "rnTime" = 1 then "testResultId" end) as "latestTestResultId"`,
    );
  });
});

describe("statusCounter — canonical status definitions", () => {
  it("counts passed as status = 'passed'", () => {
    expect(rawText(statusCounter("passed"))).toBe(
      "sum(case when status = 'passed' then 1 else 0 end)",
    );
  });

  it("counts flaky as status = 'flaky'", () => {
    expect(rawText(statusCounter("flaky"))).toBe(
      "sum(case when status = 'flaky' then 1 else 0 end)",
    );
  });

  it("counts skipped as status = 'skipped'", () => {
    expect(rawText(statusCounter("skipped"))).toBe(
      "sum(case when status = 'skipped' then 1 else 0 end)",
    );
  });

  it("counts FAIL as status in ('failed','timedout') — the one canonical definition", () => {
    // The load-bearing invariant: the flaky-vs-failed boundary lives HERE, not
    // re-stated across tests.server.ts + slowest-tests.server.ts by eye.
    expect(rawText(statusCounter("fail"))).toBe(
      "sum(case when status in ('failed','timedout') then 1 else 0 end)",
    );
  });
});

describe("statusCounter — aliasing + column threading", () => {
  it("appends `as <alias>` when given an alias (tests.server.ts counters)", () => {
    expect(rawText(statusCounter("passed", { alias: `"passedCount"` }))).toBe(
      `sum(case when status = 'passed' then 1 else 0 end) as "passedCount"`,
    );
    expect(rawText(statusCounter("fail", { alias: `"failCount"` }))).toBe(
      `sum(case when status in ('failed','timedout') then 1 else 0 end) as "failCount"`,
    );
  });

  it("reads a custom status column when asked (table-qualified)", () => {
    expect(rawText(statusCounter("flaky", { statusCol: "tr.status" }))).toBe(
      "sum(case when tr.status = 'flaky' then 1 else 0 end)",
    );
  });

  it("binds nothing — status literals are inline raw SQL, never params", () => {
    noBoundArgs(statusCounter("fail"));
    noBoundArgs(statusCounter("passed", { alias: `"passedCount"` }));
  });

  it("matches, byte-for-byte, the counter idioms the loaders previously inlined", () => {
    // The exact strings from tests.server.ts:250-253 and slowest-tests.server.ts:185-186.
    expect(rawText(statusCounter("passed", { alias: `"passedCount"` }))).toBe(
      `sum(case when status = 'passed' then 1 else 0 end) as "passedCount"`,
    );
    expect(rawText(statusCounter("flaky", { alias: `"flakyCount"` }))).toBe(
      `sum(case when status = 'flaky' then 1 else 0 end) as "flakyCount"`,
    );
    expect(rawText(statusCounter("fail", { alias: `"failCount"` }))).toBe(
      `sum(case when status in ('failed','timedout') then 1 else 0 end) as "failCount"`,
    );
    expect(rawText(statusCounter("skipped", { alias: `"skippedCount"` }))).toBe(
      `sum(case when status = 'skipped' then 1 else 0 end) as "skippedCount"`,
    );
  });
});
