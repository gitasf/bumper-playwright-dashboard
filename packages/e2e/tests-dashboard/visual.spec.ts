/**
 * Visual regression baseline for the run-detail page.
 *
 * Disabled by default — Playwright snapshots are platform-specific
 * (font hinting + OS-level rendering differs between macOS and the
 * Linux CI runner), so a baseline committed from one platform diffs
 * against the other. To enable:
 *
 *   1. Local-only triage: WRIGHTFUL_VISUAL_BASELINE_OK=1 + run with
 *      --update-snapshots. Use the generated PNG to inspect what's
 *      changed; do NOT commit a macOS PNG.
 *
 *   2. CI ratchet: enable the env var in `.github/workflows/ci.yml`
 *      for the test-e2e-dashboard job, generate Linux baselines via a
 *      one-shot --update-snapshots run, commit them, then re-enable
 *      in the regular CI job.
 */
import { expect, test } from "./fixtures";

const VISUAL_ENABLED = process.env.WRIGHTFUL_VISUAL_BASELINE_OK === "1";

test.describe("Visual regression", () => {
  test.skip(!VISUAL_ENABLED, "Set WRIGHTFUL_VISUAL_BASELINE_OK=1 to enable");

  test("run-detail page matches the committed baseline", async ({
    page,
    runDetailPage,
    openSeededRun,
  }) => {
    // Viewport must be set BEFORE navigating (Playwright resizes the current
    // page) — openSeededRun navigates lazily when invoked, so this ordering
    // still holds.
    await page.setViewportSize({ width: 1440, height: 900 });
    await openSeededRun();

    // Wait for the synced-state subscription to settle. Anchored on the
    // test-row links being visible — proves data has streamed in.
    await expect(runDetailPage.testRowLinks.first()).toBeVisible();

    await expect(page).toHaveScreenshot("run-detail.png", {
      fullPage: true,
      mask: [
        page.locator("[data-testid='timestamp']"),
        page.locator(".tabular-nums"),
        page.locator("[class*='font-mono'][class*='text-muted-foreground']"),
      ],
      animations: "disabled",
    });
  });
});
