import { describe, expect, it } from "vite-plus/test";
import { buildCheckRunOutput, statusToConclusion } from "@/lib/github-checks";

/**
 * Pure core of the GitHub check-run pipeline: the merge-gate decision and the
 * rendered output. `maybePostGithubCheck` (DB + GitHub API) is integration-only.
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
});
