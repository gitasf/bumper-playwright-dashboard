import { test as base } from "@playwright/test";

import { FAILURES_BRANCH } from "./global-setup";
import { ApiKeysPage } from "./pages/api-keys.page";
import { GroupsPage } from "./pages/groups.page";
import { LoginPage } from "./pages/login.page";
import { MonitorsPage } from "./pages/monitors.page";
import { RunDetailPage } from "./pages/run-detail.page";
import { RunsListPage } from "./pages/runs-list.page";
import { readFixture, type SerializedFixture } from "./helpers/fixture";
import { acquireMonitorSchedulerLease } from "./helpers/monitor-scheduler-lease";

/**
 * Custom Playwright test extended with our project-specific fixtures.
 *
 * Specs that need the seeded user/team/project metadata declare
 * `async ({ ctx, runsListPage })` and Playwright wires it up. The
 * `ctx` fixture is a thin alias over the JSON file written by
 * global-setup; it's a worker-scoped read so we don't re-parse the
 * file once per test.
 *
 * Page objects are test-scoped (one fresh instance per test) — they
 * close over `page`, which Playwright resets between tests.
 */
export interface DashboardFixtures {
  ctx: SerializedFixture;
  loginPage: LoginPage;
  runsListPage: RunsListPage;
  runDetailPage: RunDetailPage;
  apiKeysPage: ApiKeysPage;
  monitorsPage: MonitorsPage;
  groupsPage: GroupsPage;
  /**
   * Run one monitor's scheduled cycle without another Playwright worker
   * advancing the same global scheduler. The monitor must be created paused;
   * this fixture resumes it only while holding the cross-process lease and
   * pauses it again before release, including on assertion failure.
   */
  monitorScheduler: {
    run: (monitorId: string, action: () => Promise<void>) => Promise<void>;
  };
  /**
   * Navigate to the detail page of a seeded run and return its runId.
   * Collapses the `runsListPage.goto()` → `firstRunId()` → `runDetailPage.goto()`
   * preamble. Defaults to the failures-scenario branch rather than the
   * project's newest run: with parallel workers, realtime.spec and
   * monitors.spec create fresh runs in this same project mid-suite, so
   * "newest run" is non-deterministic. The branch filter pins the target to
   * a run only global-setup writes (monitor stub runs carry `branch: null`
   * and realtime's branches are unique-per-test, so neither can match).
   */
  openSeededRun: (branch?: string) => Promise<string>;
}

export const test = base.extend<
  DashboardFixtures,
  { ctxWorker: SerializedFixture }
>({
  // Worker-scoped: read fixture.json exactly once per worker.
  // Playwright requires the destructuring pattern even when empty —
  // it's how the framework signals there are no upstream fixture deps.
  ctxWorker: [
    // oxlint-disable-next-line no-empty-pattern
    async ({}, use) => {
      await use(readFixture());
    },
    { scope: "worker" },
  ],

  ctx: async ({ ctxWorker }, use) => {
    await use(ctxWorker);
  },

  loginPage: async ({ page }, use) => {
    await use(new LoginPage(page));
  },

  runsListPage: async ({ page, ctx }, use) => {
    await use(new RunsListPage(page, ctx.teamSlug, ctx.projectSlug));
  },

  runDetailPage: async ({ page, ctx }, use) => {
    await use(new RunDetailPage(page, ctx.teamSlug, ctx.projectSlug));
  },

  apiKeysPage: async ({ page, ctx }, use) => {
    await use(new ApiKeysPage(page, ctx.teamSlug, ctx.projectSlug));
  },

  monitorsPage: async ({ page, ctx }, use) => {
    await use(new MonitorsPage(page, ctx.teamSlug, ctx.projectSlug));
  },

  monitorScheduler: async ({ monitorsPage }, use) => {
    await use({
      run: async (monitorId, action) => {
        const release = await acquireMonitorSchedulerLease();
        let resumed = false;
        try {
          await monitorsPage.gotoDetail(monitorId);
          await monitorsPage.resume();
          resumed = true;
          await action();
        } finally {
          try {
            if (resumed) {
              await monitorsPage.gotoDetail(monitorId);
              await monitorsPage.pause();
            }
          } finally {
            await release();
          }
        }
      },
    });
  },

  groupsPage: async ({ page, ctx }, use) => {
    await use(new GroupsPage(page, ctx.teamSlug));
  },

  openSeededRun: async ({ runsListPage, runDetailPage }, use) => {
    await use(async (branch: string = FAILURES_BRANCH) => {
      await runsListPage.goto(`branch=${encodeURIComponent(branch)}`);
      const runId = await runsListPage.firstRunId();
      await runDetailPage.goto(runId);
      return runId;
    });
  },
});

export { expect } from "@playwright/test";
