import { expect, test } from "./fixtures";
import { FAILURES_BRANCH } from "./global-setup";

test.describe("Authed navigation", () => {
  test("project page renders the Runs heading and at least one run row", async ({
    runsListPage,
  }) => {
    await runsListPage.goto();
    await runsListPage.expectLoaded();
    await expect(runsListPage.emptyState).not.toBeVisible();
    await expect(runsListPage.runLinks.first()).toBeVisible();
  });

  test("clicking a run row navigates to the run-detail page", async ({
    runsListPage,
  }) => {
    // Branch-filtered: the unfiltered list live-inserts rows via the project
    // WS room, so with parallel workers a run created by realtime.spec or
    // monitors.spec can slide in between reading the first row's href and
    // clicking it. The failures branch only ever holds the seeded run.
    await runsListPage.goto(`branch=${encodeURIComponent(FAILURES_BRANCH)}`);
    await runsListPage.clickFirstRun();
  });

  test("404 on a project that doesn't exist (no team-existence leak)", async ({
    page,
    runsListPage,
  }) => {
    const res = await page.goto(`/t/${runsListPage.teamSlug}/p/does-not-exist`);
    expect(res?.status()).toBe(404);
    // NotFoundPage renders, not the runs-list page chrome.
    await expect(page.getByText(/page not found/i)).toBeVisible();
    await expect(runsListPage.heading).not.toBeVisible();
  });
});
