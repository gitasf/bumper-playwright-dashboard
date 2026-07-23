import { describe, expect, it } from "vite-plus/test";
import { buildCheckRunOutput, buildCheckRunPath } from "@/lib/github-checks";
import { statusToConclusion } from "@/lib/github-run-render";

/**
 * Pure core of the GitHub check-run pipeline: the merge-gate decision and the
 * rendered output. `postCheckRunSurface` (DB + GitHub API) is integration-only
 * — see `github-checks-claim.test.ts` (pglite-backed, Node lane) for the
 * claim-before-POST concurrency coverage; it can't live here because pglite
 * is deliberately Node-lane-only (see `vitest.workers.config.ts`).
 */

describe("statusToConclusion", () => {
  it("passes only on a passed run", () => {
    expect(statusToConclusion("passed")).toBe("success");
  });

  it("fails on failed / timedout / interrupted (incomplete = don't merge)", () => {
    expect(statusToConclusion("failed")).toBe("failure");
    expect(statusToConclusion("timedout")).toBe("failure");
    expect(statusToConclusion("interrupted")).toBe("failure");
  });

  it("is neutral (non-blocking) for an unrecognized status", () => {
    expect(statusToConclusion("running")).toBe("neutral");
    expect(statusToConclusion("whatever")).toBe("neutral");
  });
});

describe("buildCheckRunOutput", () => {
  const detailsUrl = "https://dash.example/t/acme/p/web/runs/r1";

  it("titles a passing run with the pass count and notes flakes", () => {
    const out = buildCheckRunOutput(
      {
        status: "passed",
        passed: 10,
        failed: 0,
        flaky: 2,
        skipped: 1,
        totalTests: 13,
        durationMs: 65_000,
      },
      detailsUrl,
    );
    expect(out.title).toBe("10 passed, 2 flaky");
    expect(out.summary).toContain("| 10 | 0 | 2 | 1 | 1m 5s |");
    expect(out.summary).toContain(detailsUrl);
  });

  it("titles a failing run with the failure count", () => {
    const out = buildCheckRunOutput(
      {
        status: "failed",
        passed: 8,
        failed: 2,
        flaky: 0,
        skipped: 0,
        totalTests: 10,
        durationMs: 500,
      },
      detailsUrl,
    );
    expect(out.title).toBe("2 failed, 8 passed");
    expect(out.summary).toContain("| 8 | 2 | 0 | 0 | 500ms |");
  });

  it("carries a rounded-up 60s remainder into the minutes place instead of rendering '1m 60s'", () => {
    const out = buildCheckRunOutput(
      {
        status: "passed",
        passed: 1,
        failed: 0,
        flaky: 0,
        skipped: 0,
        totalTests: 1,
        durationMs: 119_700, // 119.7s: naive floor(minutes)+round(seconds) yields "1m 60s"
      },
      detailsUrl,
    );
    expect(out.summary).toContain("2m 0s");
    expect(out.summary).not.toContain("60s");
  });

  it("carries a sub-minute duration whose tenth rounds to 60.0 into the minutes place instead of rendering '60.0s'", () => {
    const out = buildCheckRunOutput(
      {
        status: "passed",
        passed: 1,
        failed: 0,
        flaky: 0,
        skipped: 0,
        totalTests: 1,
        durationMs: 59_960, // 59.96s: naive toFixed(1) yields "60.0s"
      },
      detailsUrl,
    );
    expect(out.summary).toContain("1m 0s");
    expect(out.summary).not.toContain("60.0s");
  });
});

describe("buildCheckRunPath", () => {
  it("builds the POST path for a normal owner/name repo", () => {
    expect(buildCheckRunPath("acme/web", null)).toBe(
      "/repos/acme/web/check-runs",
    );
  });

  it("builds the PATCH path when an existing check run id is given", () => {
    expect(buildCheckRunPath("acme/web", 42)).toBe(
      "/repos/acme/web/check-runs/42",
    );
  });

  it("percent-encodes reserved characters in repo so they can't reinterpret the request path (e.g. a '?' truncating /check-runs into a query string)", () => {
    const path = buildCheckRunPath("acme/repo?evil=1", null);
    expect(path).toBe("/repos/acme/repo%3Fevil%3D1/check-runs");
    expect(path.endsWith("/check-runs")).toBe(true);
    expect(path).not.toContain("?");
  });
});
