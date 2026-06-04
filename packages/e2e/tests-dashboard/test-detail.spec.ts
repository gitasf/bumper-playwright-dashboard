import { expect, test } from "./fixtures";
import { FAILURES_BRANCH } from "./global-setup";

test.describe("Test detail page", () => {
  test("clicking a test row from run-detail navigates to test-detail", async ({
    page,
    runsListPage,
    runDetailPage,
  }) => {
    await runsListPage.goto();
    const runId = await runsListPage.firstRunId();
    await runDetailPage.goto(runId);
    await runDetailPage.clickFirstTest();
    await expect(page).toHaveURL(new RegExp(`/runs/${runId}/tests/`));
  });

  test("test-detail renders the spec-title heading", async ({
    runsListPage,
    runDetailPage,
  }) => {
    await runsListPage.goto();
    const runId = await runsListPage.firstRunId();
    await runDetailPage.goto(runId);
    await runDetailPage.clickFirstTest();
    await expect(runDetailPage.testTitleHeading).toBeVisible({
      timeout: 10_000,
    });
  });

  test("test-detail URL renders the back-link to the parent run", async ({
    page,
    runsListPage,
    runDetailPage,
  }) => {
    await runsListPage.goto();
    const runId = await runsListPage.firstRunId();
    await runDetailPage.goto(runId);
    await runDetailPage.clickFirstTest();

    const runBackLink = page.locator(`a[href$="/runs/${runId}"]`);
    await expect(runBackLink.first()).toBeVisible();
  });

  test("visual diff dialog opens with all four mode tabs", async ({
    page,
    runsListPage,
    runDetailPage,
  }) => {
    // Filter to the failures-scenario run that carries the visual diff
    // (seeded by upload-fixtures.mjs → 02-feature-flaky).
    await runsListPage.goto(`branch=${encodeURIComponent(FAILURES_BRANCH)}`);
    const runId = await runsListPage.firstRunId();
    await runDetailPage.goto(runId);

    // The failures run holds tests across multiple files; navigate to the
    // visual-regression test specifically rather than the first row.
    const visualTestLink = page.getByRole("link", {
      name: /hero copy.*pricing match baseline/i,
    });
    await expect(visualTestLink).toBeVisible({ timeout: 10_000 });
    await visualTestLink.click();
    await page.waitForURL(/\/tests\//, { timeout: 10_000 });

    // Rail button label is "Visual diff <snapshotName>" — the reporter
    // strips the file extension, so the seed's `landing.png` shows as
    // "Visual diff landing".
    const trigger = page.getByRole("button", {
      name: /visual diff\s+landing/i,
    });
    await expect(trigger).toBeVisible({ timeout: 10_000 });
    await trigger.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/visual diff failed/i)).toBeVisible();

    for (const name of ["Diff", "Expected", "Actual", "Side-by-side"]) {
      await expect(dialog.getByRole("tab", { name })).toBeVisible();
    }

    // Diff is the default mode; clicking Expected switches the active tab and
    // updates `?vmode=` so the user's choice is sticky / deep-linkable.
    await dialog.getByRole("tab", { name: "Expected" }).click();
    await expect(page).toHaveURL(/[?&]vmode=expected/);
    await expect(dialog.getByRole("tab", { selected: true })).toHaveText(
      "Expected",
    );
  });
});
