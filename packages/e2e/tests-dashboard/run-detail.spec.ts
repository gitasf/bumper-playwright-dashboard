import { expect, test } from "./fixtures";

test.describe("Run detail", () => {
  test("renders the run-detail page chrome for a real run", async ({
    runsListPage,
    runDetailPage,
  }) => {
    await runsListPage.goto();
    const runId = await runsListPage.firstRunId();
    const response = await runDetailPage.page.goto(
      runDetailPage.pathFor(runId),
    );
    expect(response?.status()).toBe(200);
    await expect(runDetailPage.backLink().first()).toBeVisible();
  });

  test("lists at least one test result row from the seeded run", async ({
    runDetailPage,
    openSeededRun,
  }) => {
    await openSeededRun();
    // Rows live inside paginated-by-group sections; expand them so a row renders.
    await runDetailPage.expandTestGroups();
    await expect(runDetailPage.testRowLinks.first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test("404s on a phantom runId within the user's project", async ({
    page,
    runDetailPage,
  }) => {
    const phantomId = "01HZZZZZZZZZZZZZZZZZZZZZZZ";
    const res = await page.goto(runDetailPage.pathFor(phantomId));
    expect(res?.status()).toBe(404);
    await expect(page.getByText(/page not found/i)).toBeVisible();
    await expect(runDetailPage.testRowLinks).toHaveCount(0);
  });
});
