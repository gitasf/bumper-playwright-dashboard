import { expect, test } from "./fixtures";

/**
 * Logout flow.
 *
 * The suite shares one `storageState.json` across all workers. Better Auth's
 * sign-out invalidates the *current* session row server-side, which would
 * 401 every other concurrent worker that's holding the same session cookie.
 * To stay parallel-safe, this spec mints a fresh session for the primary
 * user via the API (Better Auth stores each sign-in as its own session row),
 * uses it for this test only, and lets sign-out invalidate just that one.
 * The shared storageState session — the one every other worker holds — is
 * untouched.
 */
test.describe("Logout", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("user menu → Log out lands on /login and clears the session", async ({
    page,
    context,
    ctx,
    runsListPage,
  }) => {
    // Mint a throwaway session row for the primary user.
    const signInRes = await page.request.post("/api/auth/sign-in/email", {
      headers: { "Content-Type": "application/json", Origin: ctx.url },
      data: { email: ctx.email, password: ctx.password },
    });
    expect(signInRes.ok()).toBe(true);
    const setCookies = signInRes
      .headersArray()
      .filter((h) => h.name.toLowerCase() === "set-cookie")
      .map((h) => h.value.split(";")[0]);
    expect(setCookies.length).toBeGreaterThan(0);
    const cookies = setCookies
      .map((raw) => {
        const eq = raw.indexOf("=");
        if (eq < 0) return null;
        return {
          name: raw.slice(0, eq),
          value: raw.slice(eq + 1),
          domain: "localhost",
          path: "/",
          httpOnly: true,
          secure: false,
          sameSite: "Lax" as const,
          expires: -1,
        };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);
    await context.addCookies(cookies);

    await runsListPage.goto();
    await expect(runsListPage.userMenuTrigger).toBeVisible();

    await runsListPage.logout();
    await expect(page).toHaveURL(/\/login/);

    // Cookie was actually cleared, not just hidden by the redirect.
    await page.goto(runsListPage.path);
    await expect(page).toHaveURL(/\/login/);

    const stateCookies = await context.cookies();
    const sessionCookie = stateCookies.find(
      (c) => /session/i.test(c.name) || /better-auth/i.test(c.name),
    );
    // Pass if the session cookie is absent, emptied, or expired. Structured
    // (not one boolean) so a failure names the cookie instead of "false !== true".
    if (sessionCookie) {
      expect(
        sessionCookie.value === "" || sessionCookie.expires === 0,
        `session cookie "${sessionCookie.name}" still holds a live value after logout`,
      ).toBe(true);
    }
  });
});
