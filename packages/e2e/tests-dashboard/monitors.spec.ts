import { triggerQueue, triggerScheduled } from "./helpers/dev-trigger";
import { expect, test } from "./fixtures";

/**
 * Synthetic-monitoring UI + scheduler smoke test.
 *
 * Drives the whole user-visible flow against a REAL dashboard (booted by
 * global-setup with `WRIGHTFUL_MONITOR_EXECUTOR=stub`, so the queue consumer
 * runs the in-process `StubExecutor` — no Docker / Void Sandbox):
 *
 *   1. Create a monitor through the form; assert it lands in the list with the
 *      right name + interval.
 *   2. Open its detail; assert the empty-executions state renders.
 *   3. Drive ONE scheduled cycle via Void's dev triggers (no real cron/queue):
 *        - `POST /__void/scheduled` fires the `sweep-monitors` cron. Once the
 *          monitor is due (`nextRunAt <= now`), the sweep mints a `queued`
 *          execution + enqueues a `MonitorJob`; Miniflare natively delivers it
 *          to `queues/monitors.ts`, which runs the stub → opens/streams/completes
 *          a synthetic `runs` row keyed on the execution id, and records the
 *          execution terminal state. We poll the cron until the execution lands
 *          (a fresh enabled monitor arms `nextRunAt = createdAt + intervalSeconds`,
 *          so it isn't due until one interval has elapsed — hence the generous
 *          per-test timeout and the 1-minute interval).
 *        - `POST /__void/queue` exercises the consumer's manual dispatch path +
 *          its decision contract directly: a job for a missing execution acks
 *          (nothing to run), and crucially produces no spurious run.
 *      Then assert an execution row appears on the detail page and deep-links to
 *      a run, and that the run page renders.
 *
 * No Docker / containers anywhere — the stub executor is the whole point.
 */

const SWEEP_CRON = "* * * * *";
const ONE_MINUTE = 60;

// A fresh enabled monitor is due one interval after creation, the stub run then
// streams through ingest, and the list/detail pages re-render off D1 — well
// within two minutes, but the default 30s test timeout is far too tight.
test.setTimeout(150_000);

test.describe("Synthetic monitors", () => {
  test("create, schedule one cycle via the stub executor, and link to a run", async ({
    monitorsPage,
    runDetailPage,
    page,
    ctx,
  }) => {
    const name = `pw-monitor-${Date.now()}`;
    const source = `import { test, expect } from "@playwright/test";

test("synthetic smoke", async ({ page }) => {
  await expect(1 + 1).toBe(2);
});
`;

    // 1. Create via the form, then assert it's in the list.
    await monitorsPage.gotoNew();
    const monitorId = await monitorsPage.create({
      name,
      intervalSeconds: ONE_MINUTE,
      source,
    });

    await monitorsPage.gotoList();
    const row = monitorsPage.listRowFor(name);
    await expect(row).toBeVisible();
    // The interval column humanizes 60s as "1m"; the Enabled column shows a
    // toggle that is on for a freshly-armed monitor.
    await expect(row.getByText(/^1m$/)).toBeVisible();
    await expect(row.getByRole("switch")).toBeChecked();

    // 2. Detail page: empty executions state before the scheduler runs.
    await monitorsPage.gotoDetail(monitorId);
    await expect(monitorsPage.emptyExecutions).toBeVisible();
    await expect(monitorsPage.runLinks).toHaveCount(0);

    // 3a. Manual queue dispatch contract: a job whose execution doesn't exist
    // (deleted / never-minted) must ack and produce NO run — the consumer's
    // "nothing to do" branch. Deterministic, no real execution id needed.
    const ghostMessageId = "1";
    const queueResult = await triggerQueue(
      page.request,
      ctx.url,
      ctx.devTriggerToken,
      "monitors",
      [
        {
          id: ghostMessageId,
          timestamp: Date.now(),
          body: {
            monitorId,
            executionId: `nonexistent-${Date.now()}`,
            scheduledFor: Math.floor(Date.now() / 1000),
          },
          attempts: 1,
        },
      ],
    );
    expect(queueResult.ok).toBe(true);
    expect(queueResult.decisions?.[ghostMessageId]?.action).toBe("ack");

    // Still empty — the ghost job created nothing.
    await monitorsPage.gotoDetail(monitorId);
    await expect(monitorsPage.runLinks).toHaveCount(0);

    // 3b. Fire the sweep cron until the monitor becomes due and the stub run
    // lands. Each tick is a no-op until `nextRunAt` passes; once it does, the
    // sweep enqueues exactly one job (it re-arms `nextRunAt`, so later ticks
    // don't re-fire it) and Miniflare delivers it to the stub consumer.
    await expect(async () => {
      await triggerScheduled(
        page.request,
        ctx.url,
        ctx.devTriggerToken,
        SWEEP_CRON,
      );
      await monitorsPage.gotoDetail(monitorId);
      await expect(monitorsPage.runLinks.first()).toBeVisible({
        timeout: 5_000,
      });
    }).toPass({ timeout: 130_000 });

    // The execution row carries a passing state (the stub source has no
    // FORCE_FAIL sentinel) and a "View run" deep-link.
    await expect(page.getByText(/^pass$/i).first()).toBeVisible();

    // 4. Follow the deep-link to the produced run and assert it renders.
    const runHref = await monitorsPage.runLinks.first().getAttribute("href");
    expect(runHref).toBeTruthy();
    const runId = runHref?.match(/\/runs\/([^/?#]+)/)?.[1];
    expect(runId).toBeTruthy();

    await runDetailPage.goto(runId as string);
    // The synthetic run streamed two fake tests; the Tests tab links them.
    await expect(runDetailPage.testRowLinks.first()).toBeVisible({
      timeout: 15_000,
    });
  });
});
