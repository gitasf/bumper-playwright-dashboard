import { test, expect } from "@playwright/test";
import { pace } from "./pace";
import { gotoShop } from "./mock-site";

// Optional per-test delay so `seed:stream` runs slow enough to watch live.
test.afterEach(pace);

// These drive the fake storefront (mock-site.ts) rather than a static
// `setContent` page, so every seeded trace carries Console + Network entries
// for the trace viewer to render.

test.describe("Shopping cart", () => {
  test("adds item to basket @smoke @cart", async ({ page }) => {
    await gotoShop(page);
    await page.click("#add");
    await expect(page.locator("#items li")).toHaveCount(1);
  });

  test("removes item from basket @cart", async ({ page }) => {
    await gotoShop(page);
    await page.click("#add");
    await page.click("#add");
    await page.click("#remove");
    await expect(page.locator("#items li")).toHaveCount(1);
  });

  test("persists basket across interactions @cart @persistence", async ({
    page,
  }) => {
    await gotoShop(page);
    await page.click("#add");
    await page.click("#add");
    await page.click("#add");
    await expect(page.locator("#items li")).toHaveCount(3);
  });
});
