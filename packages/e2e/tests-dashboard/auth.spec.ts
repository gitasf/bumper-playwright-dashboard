import { expect, test } from "./fixtures";

// Email auth intentionally performs password hashing on the local worker.
// Leave room for that real operation plus browser navigation on a slow runner.
test.setTimeout(60_000);

test.describe("Auth", () => {
  test.describe("anonymous", () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test("redirects an anonymous visitor from / to /login", async ({
      page,
    }) => {
      const response = await page.goto("/");
      await expect(page).toHaveURL(/\/login(\?|$)/);
      expect(response?.ok()).toBe(true);
    });

    test("redirects an anonymous visitor from a deep team page to /login", async ({
      page,
      ctx,
    }) => {
      await page.goto(`/t/${ctx.teamSlug}/p/${ctx.projectSlug}`);
      await expect(page).toHaveURL(/\/login(\?|$)/);
    });

    test("shows an inline error for invalid sign-in credentials", async ({
      loginPage,
      ctx,
    }) => {
      await loginPage.gotoSignIn();
      await loginPage.signIn(ctx.email, "not-the-real-password");
      // Generous timeout — the failed sign-in still runs the slow scrypt
      // verify on the local miniflare server before the error comes back.
      await expect(loginPage.errorAlert).toBeVisible({ timeout: 30_000 });
      await expect(loginPage.page).toHaveURL(/\/login/);
    });

    test("logs in with valid credentials and lands on the team page", async ({
      loginPage,
      ctx,
    }) => {
      await loginPage.gotoSignIn();
      await loginPage.signIn(ctx.email, ctx.password);
      await loginPage.waitForLandedOff("/login");
      await expect(loginPage.page).not.toHaveURL(/\/login/);
    });

    // Regression: an invited user opening `/invite/:token` while signed out is
    // bounced to `/login?next=/invite/:token`. The login page must honor that
    // `next` after auth — otherwise it dumps them on `/` (the "No teams yet"
    // picker) instead of the invite. The GitHub `callbackURL` reads the same
    // server-validated `next` prop this exercises (the OAuth provider itself
    // can't be driven in e2e).
    test("honors a ?next redirect after email sign-in", async ({
      loginPage,
      ctx,
    }) => {
      const next = `/t/${ctx.teamSlug}/p/${ctx.projectSlug}`;
      await loginPage.gotoSignIn(`next=${encodeURIComponent(next)}`);
      await loginPage.signIn(ctx.email, ctx.password);
      await loginPage.page.waitForURL((url) => url.pathname.startsWith(next), {
        timeout: 30_000,
      });
    });

    // Open-redirect guard: a hostile `next` (protocol-relative off-site URL)
    // must be sanitized to `/` by `safeNextPath`, never followed. The user
    // stays on the app origin.
    test("sanitizes a hostile ?next and stays on-origin", async ({
      loginPage,
      ctx,
    }) => {
      await loginPage.gotoSignIn("next=//evil.example.com/pwned");
      await loginPage.signIn(ctx.email, ctx.password);
      await loginPage.waitForLandedOff("/login");
      expect(new URL(loginPage.page.url()).hostname).not.toContain(
        "evil.example.com",
      );
    });
  });

  test("authed visitor on / is not bounced back to /login", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page).not.toHaveURL(/\/login/);
  });
});
