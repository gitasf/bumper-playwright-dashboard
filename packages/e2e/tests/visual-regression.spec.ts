import { expect, test } from "@playwright/test";

// Verification harness for Wrightful's visual-regression artifact pipeline.
//
// To exercise the failure path (which is when Playwright emits the
// expected/actual/diff triple that the reporter promotes to `type: "visual"`):
//
//   1. Generate the baseline against the unmodified homepage:
//        pnpm test:e2e --update-snapshots tests/visual-regression.spec.ts
//      and commit the produced `__screenshots__` files.
//
//   2. Uncomment the page.evaluate() block below to mutate the page before
//      capture, then run:
//        WRIGHTFUL_URL=… WRIGHTFUL_TOKEN=… pnpm test:e2e tests/visual-regression.spec.ts
//      The reporter ships three image attachments labelled with role +
//      snapshotName; the test detail page renders one "Visual diff" entry.
test.describe("Visual regression dogfood", () => {
  test("homepage matches baseline", async ({ page }) => {
    await page.goto("/");
    // Wait for the hero heading to settle so the snapshot is deterministic —
    // an explicit locator wait, not `networkidle` (discouraged; long-lived
    // connections can keep the network from ever going idle).
    await expect(page.getByRole("heading").first()).toBeVisible();

    // Toggle this block on to inject a page-mutating banner — the next run
    // will produce a diff and exercise the visual-regression pipeline:
    //
    // await page.evaluate(() => {
    //   const banner = document.createElement("div");
    //   banner.style.cssText =
    //     "position:fixed;top:0;left:0;right:0;height:48px;" +
    //     "background:hotpink;color:white;font:16px sans-serif;" +
    //     "display:flex;align-items:center;justify-content:center;" +
    //     "z-index:99999;";
    //   banner.textContent = "verification banner";
    //   document.body.appendChild(banner);
    // });

    await expect(page).toHaveScreenshot("homepage.png", {
      // Loosen pixel tolerance for fonts/anti-aliasing across runners.
      maxDiffPixelRatio: 0.02,
    });
  });
});
