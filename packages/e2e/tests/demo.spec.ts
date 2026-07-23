import { test, expect } from "@playwright/test";

test.describe("Demo test suite", () => {
  test("should load a page", async ({ page }) => {
    await page.goto("/");
    // Emit test-process stdout so the dashboard's per-attempt "Output" tab
    // (captured stdout/stderr) has real data to show for a passing test.
    console.log(`[demo] loaded page with title: ${await page.title()}`);
    await expect(page).toHaveTitle(/Playwright/);
  });

  test("should have navigation", async ({ page }) => {
    await page.goto("/");
    const nav = page.locator("nav");
    await expect(nav).toBeVisible();
  });

  test("should have docs link", async ({ page }) => {
    await page.goto("/docs/intro");
    await expect(page.locator("h1")).toBeVisible();
  });

  // Deliberately flaky, for dogfooding: the first attempt fails, the retry
  // (playwright.config.ts sets `retries: 1`) passes, so the reporter records a
  // `flaky` result with two attempts. This seeds the dashboard's flaky-tests
  // page AND the MCP `list_flaky_tests` tool with real data — the e2e suite
  // asserts on it. Don't "fix" it into a stable pass.
  test("flaky by design: passes only on retry", async ({ page }, testInfo) => {
    await page.goto("/");
    // Test-process stdout/stderr, so the failing FIRST attempt carries real
    // captured logs in the dashboard's per-attempt "Output" tab — mirroring the
    // console.log debugging an author leaves in a CI-only flaky test.
    console.log(`[demo] flaky check — attempt retry=${testInfo.retry}`);
    if (testInfo.retry === 0) {
      console.error("[demo] first attempt: retry is 0 — failing by design");
    }
    expect(testInfo.retry, "first attempt fails by design").toBeGreaterThan(0);
  });
});
