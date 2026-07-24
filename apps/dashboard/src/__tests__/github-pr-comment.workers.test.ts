import { describe, expect, it } from "vite-plus/test";
import {
  bucketListedResults,
  buildIssueCommentPath,
  buildPrCommentBody,
  prCommentMarker,
} from "@/lib/github-pr-comment";
import type { PrCommentContent } from "@/lib/github-pr-comment";
import type { RunDiff } from "@/lib/runs/diff";

const RUN_URL = "https://dash.example/t/acme/p/web/runs/run-1";

function content(overrides: Partial<PrCommentContent> = {}): PrCommentContent {
  return {
    projectId: "proj-1",
    status: "passed",
    passed: 10,
    failed: 0,
    flaky: 0,
    skipped: 0,
    durationMs: 90_000,
    runUrl: RUN_URL,
    commitSha: "deadbeefcafe",
    hasBase: false,
    baseCommitSha: null,
    newFailures: [],
    knownFailures: [],
    flakyTests: [],
    ...overrides,
  };
}

describe("prCommentMarker", () => {
  it("scopes the marker by projectId and stays distinct from the reporter marker", () => {
    expect(prCommentMarker("proj-1")).toBe(
      "<!-- wrightful:pr-summary:proj-1 -->",
    );
    expect(prCommentMarker("proj-1")).not.toContain("wrightful:pr-comment ");
  });
});

describe("buildPrCommentBody", () => {
  it("renders a passing run: marker, check-run headline parity, table, run link, no sections", () => {
    const body = buildPrCommentBody(content({ flaky: 2 }));
    expect(body).toContain(prCommentMarker("proj-1"));
    expect(body).toContain("### ✅ Wrightful — 10 passed, 2 flaky");
    expect(body).toContain("| 10 | 0 | 2 | 0 | 1m 30s |");
    expect(body).toContain(`[View run report →](${RUN_URL})`);
    expect(body).toContain("_Commit: `deadbee`_");
    expect(body).not.toContain("New failures");
    expect(body).not.toContain("Still failing");
    expect(body).not.toContain("Compare to base");
  });

  it("splits failures new-vs-known with deep links and a compare link when a base exists", () => {
    const body = buildPrCommentBody(
      content({
        status: "failed",
        passed: 8,
        failed: 3,
        flaky: 1,
        hasBase: true,
        baseCommitSha: "0123456789ab",
        newFailures: [
          {
            title: "checkout > pays",
            file: "checkout.spec.ts",
            testResultId: "tr-1",
          },
          {
            title: "checkout > refunds",
            file: "checkout.spec.ts",
            testResultId: null,
          },
        ],
        knownFailures: [
          { title: "login > sso", file: "login.spec.ts", testResultId: "tr-2" },
        ],
        flakyTests: [
          { title: "cart > add", file: "cart.spec.ts", testResultId: "tr-3" },
        ],
      }),
    );
    expect(body).toContain("### ❌ Wrightful — 3 failed, 8 passed");
    expect(body).toContain(
      "**New failures (2)** — passing on the base run, failing here",
    );
    expect(body).toContain(
      `- [checkout > pays](${RUN_URL}/tests/tr-1) — \`checkout.spec.ts\``,
    );
    // No testResultId → plain text, not a broken link.
    expect(body).toContain("- checkout > refunds — `checkout.spec.ts`");
    expect(body).toContain(
      "**Still failing (1)** — already failing on the base run",
    );
    expect(body).toContain(`- [login > sso](${RUN_URL}/tests/tr-2)`);
    expect(body).toContain("**Flaky (1)** — passed only after retry");
    expect(body).toContain(`[Compare to base →](${RUN_URL}/diff)`);
    expect(body).toContain("_Commit: `deadbee` · Base: `0123456`_");
  });

  it("collapses to a single Failures section when no base run exists", () => {
    const body = buildPrCommentBody(
      content({
        status: "failed",
        failed: 1,
        newFailures: [{ title: "a", file: "a.spec.ts", testResultId: "tr-1" }],
      }),
    );
    expect(body).toContain(
      "**Failures (1)** — no baseline run to compare against",
    );
    expect(body).not.toContain("New failures");
    expect(body).not.toContain("Compare to base");
  });

  it("neutralizes backticks/newlines in untrusted filenames and shas so they can't escape their code spans", () => {
    const body = buildPrCommentBody(
      content({
        status: "failed",
        failed: 1,
        commitSha: "``evil\nsha1234",
        newFailures: [
          // Git permits both backticks and newlines in path components; a raw
          // interpolation would close the span and inject the @-mention.
          { title: "t", file: "x`\n@maintainer`.spec.ts", testResultId: null },
        ],
      }),
    );
    expect(body).toContain("- t — `x @maintainer.spec.ts`");
    expect(body).not.toContain("x`");
    expect(body).toContain("_Commit: `evil sh`_");
  });

  it("truncates a section past 10 tests with an '…and N more' line", () => {
    const many = Array.from({ length: 13 }, (_, i) => ({
      title: `test ${i}`,
      file: "big.spec.ts",
      testResultId: `tr-${i}`,
    }));
    const body = buildPrCommentBody(
      content({ status: "failed", failed: 13, newFailures: many }),
    );
    expect(body).toContain("**Failures (13)**");
    expect(body).toContain("- …and 3 more");
    expect(body).toContain("tr-9");
    expect(body).not.toContain("tr-10");
  });

  it("escapes markdown-active characters and collapses newlines in titles", () => {
    const body = buildPrCommentBody(
      content({
        status: "failed",
        failed: 1,
        newFailures: [
          {
            title: "renders [brackets] and `ticks`\nacross lines",
            file: "a.spec.ts",
            testResultId: "tr-1",
          },
        ],
      }),
    );
    expect(body).toContain(
      "[renders \\[brackets\\] and \\`ticks\\` across lines]",
    );
  });

  it("uses a neutral headline for an unrecognized status", () => {
    const body = buildPrCommentBody(content({ status: "running" }));
    expect(body).toContain("### ⚪ Wrightful —");
  });
});

describe("buildIssueCommentPath", () => {
  it("targets the PR's comment collection for a new comment", () => {
    expect(buildIssueCommentPath("acme/web", 41, null)).toBe(
      "/repos/acme/web/issues/41/comments",
    );
  });

  it("targets the existing comment id for an update", () => {
    expect(buildIssueCommentPath("acme/web", 41, 900)).toBe(
      "/repos/acme/web/issues/comments/900",
    );
  });

  it("percent-encodes reserved chars in the attacker-controlled repo string", () => {
    expect(buildIssueCommentPath("acme/web?x=1#f", 41, null)).toBe(
      "/repos/acme/web%3Fx%3D1%23f/issues/41/comments",
    );
  });
});

describe("bucketListedResults", () => {
  const rows = [
    {
      id: "tr-new",
      testId: "t-new",
      title: "new",
      file: "a.spec.ts",
      status: "failed",
    },
    {
      id: "tr-known",
      testId: "t-known",
      title: "known",
      file: "b.spec.ts",
      status: "timedout",
    },
    {
      id: "tr-added",
      testId: "t-added",
      title: "added",
      file: "c.spec.ts",
      status: "failed",
    },
    {
      id: "tr-flaky",
      testId: "t-flaky",
      title: "flaky",
      file: "d.spec.ts",
      status: "flaky",
    },
  ];
  const change = (testId: string) => ({
    testId,
    baseStatus: "passed",
    headStatus: "failed",
    durationDeltaMs: null,
  });
  const diff: RunDiff = {
    newlyFailed: [change("t-new")],
    newlyPassed: [],
    stillFailing: [change("t-known")],
    flakyDeltas: [],
    addedTests: [
      { testId: "t-added", status: "failed", durationMs: 5 },
      // An added PASSING test is not a failure and must not be listed.
      { testId: "t-added-pass", status: "passed", durationMs: 5 },
    ],
    removedTests: [],
  };

  it("maps diff buckets to sections, counting failing added tests as new", () => {
    const buckets = bucketListedResults(rows, diff);
    expect(buckets.newFailures.map((t) => t.testResultId)).toEqual([
      "tr-new",
      "tr-added",
    ]);
    expect(buckets.knownFailures.map((t) => t.testResultId)).toEqual([
      "tr-known",
    ]);
    expect(buckets.flakyTests.map((t) => t.testResultId)).toEqual(["tr-flaky"]);
  });

  it("treats every failing row as new when there is no diff", () => {
    const buckets = bucketListedResults(rows, null);
    expect(buckets.newFailures.map((t) => t.testResultId)).toEqual([
      "tr-new",
      "tr-known",
      "tr-added",
    ]);
    expect(buckets.knownFailures).toEqual([]);
    expect(buckets.flakyTests.map((t) => t.testResultId)).toEqual(["tr-flaky"]);
  });
});
