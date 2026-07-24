import { test, expect } from "@playwright/test";
import { pace } from "./pace";
import { gotoShop } from "./mock-site";

// Optional per-test delay so `seed:stream` runs slow enough to watch live.
test.afterEach(pace);

// These drive the fake storefront (mock-site.ts) rather than a static
// `setContent` page, so every seeded trace carries Console + Network entries
// for the trace viewer to render.

test.describe("Checkout", () => {
  test("completes with credit card @smoke @checkout", async ({ page }) => {
    await gotoShop(page);
    await page.click("#pay");
    await expect(page.locator("#status")).toHaveText("Paid");
  });

  test("applies promo code @checkout", async ({ page }) => {
    await gotoShop(page);
    await page.fill("#promo", "SAVE10");
    await page.click("#apply");
    await expect(page.locator("#discount")).toContainText("10% off");
  });

  test.skip("shows confirmation email copy @checkout @fixme", async ({
    page,
  }) => {
    await gotoShop(page);
    await expect(page.locator("#confirmation")).toBeVisible();
  });
});
