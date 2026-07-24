import { randomUUID } from "node:crypto";
import { expect, test } from "./fixtures";

/**
 * Monitor alert controls on the detail page (owner-only): the Mute/Unmute
 * toggle (`monitors.alertsEnabled`) and the alert-recipients picker
 * (`monitors.alertTargets`).
 *
 * Email-independent — no send is exercised; this asserts the two settings
 * round-trip through the real writes (`setMonitorAlertsEnabled` for the toggle;
 * `updateMonitor`, which now persists `alertTargets` alongside the config, for
 * the in-modal recipients picker) and re-render correctly after a reload (so a
 * regression in the toggle/picker form wiring or the `alertTargets`
 * serialize/parse is caught). An http (uptime) monitor is used because it
 * creates without the browser source editor; the alert chrome is shared across
 * types.
 */
test.setTimeout(60_000);

test.describe("Monitor alert controls", () => {
  test("mute/unmute alerts persists across reload", async ({
    monitorsPage,
  }) => {
    await monitorsPage.gotoNewHttp();
    const monitorId = await monitorsPage.createHttp({
      name: `pw-alert-mute-${randomUUID()}`,
      intervalSeconds: 60,
      url: "https://example.com",
      enabled: false,
    });

    // Alerts default on ⇒ the control offers to mute.
    await expect(monitorsPage.muteAlertsButton).toBeVisible();

    // Mute, then reload from Postgres and confirm it stuck.
    await monitorsPage.muteAlerts();
    await monitorsPage.gotoDetail(monitorId);
    await expect(monitorsPage.unmuteAlertsButton).toBeVisible();

    // Unmute, reload, confirm it flipped back.
    await monitorsPage.unmuteAlerts();
    await monitorsPage.gotoDetail(monitorId);
    await expect(monitorsPage.muteAlertsButton).toBeVisible();
  });

  test("alert recipients round-trip between all and specific", async ({
    monitorsPage,
    ctx,
  }) => {
    await monitorsPage.gotoNewHttp();
    const monitorId = await monitorsPage.createHttp({
      name: `pw-alert-recip-${randomUUID()}`,
      intervalSeconds: 60,
      url: "https://example.com",
      enabled: false,
    });

    // Recipients now live inside the edit modal — open it to reach the picker.
    // Default targets are null ⇒ "All team members" selected.
    await monitorsPage.openEdit();
    await expect(monitorsPage.recipientModeRadio("all")).toBeChecked();

    // Narrow to the primary user specifically (saving closes the modal), then
    // reopen and confirm both the mode and the member selection persisted
    // (alertTargets serialize/parse) — reloading first to read fresh from PG.
    await monitorsPage.setSpecificRecipients([ctx.email]);
    await monitorsPage.gotoDetail(monitorId);
    await monitorsPage.openEdit();
    await expect(monitorsPage.recipientModeRadio("specific")).toBeChecked();
    await expect(monitorsPage.recipientMemberCheckbox(ctx.email)).toBeChecked();

    // Reset to all members (stores null) and confirm it persisted.
    await monitorsPage.setAllRecipients();
    await monitorsPage.gotoDetail(monitorId);
    await monitorsPage.openEdit();
    await expect(monitorsPage.recipientModeRadio("all")).toBeChecked();
  });
});
