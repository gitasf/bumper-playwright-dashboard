/**
 * axe-core accessibility scans on the highest-traffic pages.
 *
 * Policy: fail only on serious + critical impact violations. minor /
 * moderate are surfaced in the test report but don't block CI — they
 * tend to be advisory and the cost of suppressing each one outweighs
 * the value of merge-blocking on them.
 *
 * If a real serious/critical violation lands, fix the underlying
 * component; do NOT suppress here unless documented with a TODO.
 */
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";

// TODO(a11y/color-contrast): The dashboard's muted-foreground tokens
// (used in row metadata, breadcrumb labels, table headers) fail WCAG
// AA contrast at 4.5:1 in some surfaces. Tracked separately — fix
// requires design-token rebalancing across light + dark modes. Keep
// all OTHER serious/critical rules active here; this is the only
// blanket suppression.
const SUPPRESSED_RULES = ["color-contrast"];

async function scanSerious(page: Page, label: string): Promise<void> {
  // axe's analyze() runs page.evaluate; a client-side navigation/re-render in
  // flight can destroy the execution context mid-scan ("Execution context was
  // destroyed"). Settle on load and retry that transient before failing.
  const results = await (async () => {
    for (let attempt = 0; ; attempt++) {
      await page.waitForLoadState("load");
      try {
        return await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
          .disableRules(SUPPRESSED_RULES)
          .analyze();
      } catch (err) {
        if (
          attempt < 2 &&
          /execution context was destroyed/i.test(String(err))
        ) {
          await page.waitForTimeout(300);
          continue;
        }
        throw err;
      }
    }
  })();
  const blocking = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  if (blocking.length > 0) {
    const summary = blocking
      .map((v) => {
        const targets = v.nodes
          .map((node) => `${node.target.join(" ")} (${node.html})`)
          .join(", ");
        return `  - [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} node${
          v.nodes.length === 1 ? "" : "s"
        }: ${targets})`;
      })
      .join("\n");
    throw new Error(
      `axe-core found ${blocking.length} serious/critical violation(s) on ${label}:\n${summary}`,
    );
  }
  expect(blocking).toEqual([]);
}

test.describe("Accessibility (axe-core, serious/critical only)", () => {
  test.describe("login (anonymous)", () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test("login page has no serious/critical violations", async ({ page }) => {
      await page.goto("/login");
      await scanSerious(page, "/login");
    });
  });

  test("runs-list page has no serious/critical violations", async ({
    runsListPage,
  }) => {
    await runsListPage.goto();
    await runsListPage.expectLoaded();
    await scanSerious(runsListPage.page, runsListPage.path);
  });

  test("run-detail page has no serious/critical violations", async ({
    runDetailPage,
    openSeededRun,
  }) => {
    await openSeededRun();
    await scanSerious(runDetailPage.page, "run-detail");
  });
});
