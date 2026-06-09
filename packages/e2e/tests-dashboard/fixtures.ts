import { test as base } from "@playwright/test";

import { ApiKeysPage } from "./pages/api-keys.page";
import { LoginPage } from "./pages/login.page";
import { MonitorsPage } from "./pages/monitors.page";
import { RunDetailPage } from "./pages/run-detail.page";
import { RunsListPage } from "./pages/runs-list.page";
import { readFixture, type SerializedFixture } from "./helpers/fixture";

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
});

export { expect } from "@playwright/test";
