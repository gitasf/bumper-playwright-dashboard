import { randomUUID } from "node:crypto";
import { MONITOR_SCHEDULER_TEST_TIMEOUT_MS } from "./helpers/monitor-scheduler-lease";
import { triggerQueue, triggerScheduled } from "./helpers/void-trigger";
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
 *   3. Drive one scheduled cycle via Void's authenticated built-worker trigger:
 *        - `POST /__void/scheduled` fires the `sweep-monitors` cron. Once the
 *          monitor is due (`nextRunAt <= now`), the sweep mints a `queued`
 *          execution + enqueues a `MonitorJob`; Miniflare natively delivers it
 *          to `queues/monitors.ts`, which runs the stub → opens/streams/completes
 *          a synthetic `runs` row keyed on the execution id, and records the
 *          execution terminal state. The trigger supplies a scheduled time just
 *          beyond the interval so the monitor is immediately due without a real
 *          one-minute wait.
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

test.setTimeout(MONITOR_SCHEDULER_TEST_TIMEOUT_MS);

test.describe("Synthetic monitors", () => {
  test("create, schedule one cycle via the stub executor, and link to a run", async ({
    monitorsPage,
    runDetailPage,
    page,
    ctx,
    monitorScheduler,
  }) => {
    const name = `pw-monitor-${randomUUID()}`;
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
      enabled: false,
    });

    await monitorsPage.gotoList();
    const row = monitorsPage.listRowFor(name);
    await expect(row).toBeVisible();
    // The interval column humanizes 60s as "1m"; the Enabled column shows a
    // toggle that stays off until this test owns the global scheduler lease.
    await expect(row.getByText(/^1m$/)).toBeVisible();
    await expect(row.getByRole("switch")).not.toBeChecked();

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
      ctx.voidProxyToken,
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

    // 3b. Resume only while this file owns the cross-worker scheduler lease.
    // The production scheduler is intentionally global, so another spec's
    // future tick would otherwise execute this monitor and invalidate the
    // attribution this test is meant to prove.
    await monitorScheduler.run(monitorId, async () => {
      await triggerScheduled(
        page.request,
        ctx.url,
        ctx.voidProxyToken,
        SWEEP_CRON,
        Date.now() + (ONE_MINUTE + 1) * 1_000,
      );
      await expect(async () => {
        await monitorsPage.gotoDetail(monitorId);
        await expect(monitorsPage.runLinks.first()).toBeVisible({
          timeout: 5_000,
        });
      }).toPass({ timeout: 45_000 });

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
});
