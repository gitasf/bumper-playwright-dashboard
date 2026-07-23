/**
 * Tenancy isolation under a real authenticated browser session.
 *
 * Setup: bootDashboard already seeded User A + team A + project A. This
 * spec creates a second identity (User B + team B + project B + API
 * key B) once per worker via the worker-scoped `secondTenant` fixture
 * below, then asserts:
 *
 *  1. UI: User A's session can't see team B's pages — NotFoundPage
 *     renders (HTTP 404 + "Not found" heading), no team-B data leaks.
 *  2. API: User A's API key can't ingest into a run owned by project B.
 */
import type { APIRequestContext } from "@playwright/test";

import { expect, test as base } from "./fixtures";
import { seedSecondUser } from "./helpers/second-user";

/** What every test in this file needs from the second tenant. */
interface SecondTenant {
  runId: string;
  teamSlug: string;
  projectSlug: string;
}

// Worker-scoped fixture: seed User B + team B + project B + API key B + an
// open run once per worker (not per test), handing each test the bits it needs
// to attempt forbidden cross-tenant access.
const test = base.extend<{}, { secondTenant: SecondTenant }>({
  secondTenant: [
    async ({ ctxWorker, playwright }, use, workerInfo) => {
      // Unique per worker: a fixed email/slug collides ("user already exists")
      // across concurrent workers. `process.pid` works since Playwright workers
      // are separate OS processes; kept over workerInfo.workerIndex to match
      // the original suffixing scheme.
      const WORKER_SUFFIX = String(process.pid);
      const SECOND_USER = {
        email: `second-${WORKER_SUFFIX}@wrightful.test`,
        password: "second-second-password-1",
        name: "Second User",
        teamSlug: `second-team-${WORKER_SUFFIX}`,
        teamName: `Second Team ${WORKER_SUFFIX}`,
        projectSlug: `second-proj-${WORKER_SUFFIX}`,
        projectName: `Second Proj ${WORKER_SUFFIX}`,
      };

      const request: APIRequestContext = await playwright.request.newContext({
        baseURL: ctxWorker.url,
      });
      let runId: string;
      try {
        const secondUser = await seedSecondUser(
          request,
          ctxWorker.url,
          SECOND_USER,
        );

        const openRunRes = await request.post("/api/runs", {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${secondUser.apiKey}`,
            "X-Wrightful-Version": "3",
          },
          data: {
            idempotencyKey: `xtenant-${Date.now()}-${workerInfo.workerIndex}`,
            run: { reporterVersion: "0.0.0", playwrightVersion: "0.0.0" },
          },
        });
        if (!openRunRes.ok()) {
          throw new Error(
            `team B openRun failed (${openRunRes.status()}): ${await openRunRes.text()}`,
          );
        }
        const body = (await openRunRes.json()) as { runId: string };
        runId = body.runId;
      } finally {
        // Seeding is done and the tests never touch this context, so dispose
        // now rather than carry it past `use`.
        await request.dispose();
      }

      await use({
        runId,
        teamSlug: SECOND_USER.teamSlug,
        projectSlug: SECOND_USER.projectSlug,
      });
    },
    { scope: "worker" },
  ],
});

test.describe("UI isolation (User A's browser session)", () => {
  test("team B's project page renders NotFoundPage for User A", async ({
    page,
    secondTenant,
  }) => {
    const res = await page.goto(
      `/t/${secondTenant.teamSlug}/p/${secondTenant.projectSlug}`,
    );
    expect(res?.status()).toBe(404);
    await expect(page.getByText(/page not found/i)).toBeVisible();
    // A leaked runs-list would render the "Runs" <h1> (PageHeader). Assert the
    // 404 shell does NOT, so this guard can actually fail if team B's chrome
    // leaks. (/all runs/i matched no UI after the heading was renamed → it was
    // a vacuous guard.)
    await expect(
      page.getByRole("heading", { name: /^Runs$/ }),
    ).not.toBeVisible();
  });

  test("team B's run-detail URL renders NotFoundPage for User A", async ({
    page,
    secondTenant,
  }) => {
    const res = await page.goto(
      `/t/${secondTenant.teamSlug}/p/${secondTenant.projectSlug}/runs/${secondTenant.runId}`,
    );
    expect(res?.status()).toBe(404);
    // A leaked run-detail would render test-row links (a[href*="/tests/"]); the
    // 404 shell renders none, so this guard can fail if team B's run leaks.
    // (The old /Tests in/ labelled-list locator matched no UI → vacuous.)
    await expect(page.locator('a[href*="/tests/"]')).toHaveCount(0);
  });

  test("team B's settings page is not visible to User A", async ({
    page,
    secondTenant,
  }) => {
    const res = await page.goto(`/settings/teams/${secondTenant.teamSlug}`);
    expect(res?.status()).not.toBe(200);
  });
});

test.describe("API isolation (User A's API key)", () => {
  test("User A's API key can't append results to a team B run", async ({
    playwright,
    ctx,
    secondTenant,
  }) => {
    const request = await playwright.request.newContext({ baseURL: ctx.url });
    try {
      const res = await request.post(
        `/api/runs/${secondTenant.runId}/results`,
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${ctx.apiKey}`, // User A's key
            "X-Wrightful-Version": "3",
          },
          data: {
            results: [
              {
                clientKey: "x",
                testId: "t1",
                title: "leak attempt",
                file: "x.spec.ts",
                status: "passed",
                durationMs: 1,
                retryCount: 0,
                tags: [],
                annotations: [],
                attempts: [
                  {
                    attempt: 0,
                    status: "passed",
                    durationMs: 1,
                    errorMessage: null,
                    errorStack: null,
                  },
                ],
              },
            ],
          },
        },
      );
      expect(res.status()).toBe(404);
    } finally {
      await request.dispose();
    }
  });

  test("User A's API key can't register artifacts against a team B run", async ({
    playwright,
    ctx,
    secondTenant,
  }) => {
    const request = await playwright.request.newContext({ baseURL: ctx.url });
    try {
      const res = await request.post("/api/artifacts/register", {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ctx.apiKey}`,
          "X-Wrightful-Version": "3",
        },
        data: {
          runId: secondTenant.runId,
          artifacts: [
            {
              testResultId: "tr-fake",
              type: "trace",
              name: "x.zip",
              contentType: "application/zip",
              sizeBytes: 1,
            },
          ],
        },
      });
      expect(res.status()).toBe(404);
    } finally {
      await request.dispose();
    }
  });
});
