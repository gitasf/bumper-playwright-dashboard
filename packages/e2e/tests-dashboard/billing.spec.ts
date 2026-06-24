import { expect, test } from "./fixtures";

/**
 * Billing — the graceful-OFF (OSS / self-host) path. The dashboard fixture boots
 * with NO `POLAR_*` env (global-setup sets only `WRIGHTFUL_MONITOR_EXECUTOR`), so
 * `billingEnabled()` is false: every team is unlimited, the billing nav link is
 * hidden, the billing page shows a self-host note with no actions, and the
 * auto-mounted Polar webhook does not exist. The seeded user owns the team
 * (createTeamForUser → owner) and is authed via the shared storageState, so the
 * owner-gated billing page is reachable.
 */
test.describe("Billing (off — OSS / self-host default)", () => {
  test("billing page shows the not-configured note and no upgrade button when Polar is unset", async ({
    page,
    ctx,
  }) => {
    const res = await page.goto(`/settings/teams/${ctx.teamSlug}/billing`);
    expect(res?.status()).toBe(200);
    await expect(page.getByText(/billing is not configured/i)).toBeVisible();
    await expect(
      page.getByRole("button", { name: /upgrade to pro/i }),
    ).toHaveCount(0);
  });

  test("the Billing nav link is hidden when billing is off", async ({
    page,
    ctx,
  }) => {
    await page.goto(`/settings/teams/${ctx.teamSlug}/general`);
    await expect(page.getByRole("link", { name: /^billing$/i })).toHaveCount(0);
  });

  test("the Polar webhook endpoint does not exist when billing is off (404)", async ({
    page,
  }) => {
    // The plugin isn't registered (billingEnabled false), so the auto-mounted
    // receiver at POST /api/auth/polar/webhooks is absent.
    const res = await page.request.post("/api/auth/polar/webhooks", {
      data: {},
    });
    expect(res.status()).toBe(404);
  });
});
