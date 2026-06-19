import { describe, expect, it } from "vite-plus/test";
import { resolveRetentionWindows } from "@/lib/retention";

/**
 * Pure core of the two-axis retention sweep — the per-team window resolution.
 * The DB/R2-touching `sweepRetention` is exercised end-to-end by the e2e
 * dogfood suite (per the standing real-D1-harness gap).
 */

const DEFAULTS = { artifactDays: 30, testResultDays: 90 };

describe("resolveRetentionWindows", () => {
  it("falls back to the env defaults when a team sets neither override", () => {
    expect(
      resolveRetentionWindows(
        { retentionArtifactDays: null, retentionTestResultsDays: null },
        DEFAULTS,
      ),
    ).toEqual({ artifactDays: 30, testResultDays: 90 });
  });

  it("uses a team override where present, default where null", () => {
    expect(
      resolveRetentionWindows(
        { retentionArtifactDays: 7, retentionTestResultsDays: null },
        DEFAULTS,
      ),
    ).toEqual({ artifactDays: 7, testResultDays: 90 });

    expect(
      resolveRetentionWindows(
        { retentionArtifactDays: null, retentionTestResultsDays: 365 },
        DEFAULTS,
      ),
    ).toEqual({ artifactDays: 30, testResultDays: 365 });
  });

  it("honors both overrides when both are set", () => {
    expect(
      resolveRetentionWindows(
        { retentionArtifactDays: 14, retentionTestResultsDays: 180 },
        DEFAULTS,
      ),
    ).toEqual({ artifactDays: 14, testResultDays: 180 });
  });
});
