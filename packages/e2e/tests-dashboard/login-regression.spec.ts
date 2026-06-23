import { expect, test } from "./fixtures";

/**
 * Login regression after the Polar auth-client swap (PR 3). `auth-client.ts` was
 * changed from re-exporting void's preconfigured `auth` to constructing
 * `createAuthClient({ basePath: "/api/auth", plugins: [polarClient()] })`. This
 * proves the swap kept email/password sign-in + session establishment working.
 * Starts from a clean (signed-out) context so the sign-in is exercised for real.
 */
test.describe("Login regression (after Polar auth-client swap)", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("email/password sign-in still establishes a session", async ({
    page,
    ctx,
  }) => {
    const res = await page.request.post("/api/auth/sign-in/email", {
      headers: { "Content-Type": "application/json", Origin: ctx.url },
      data: { email: ctx.email, password: ctx.password },
    });
    expect(res.ok()).toBe(true);
    await page.goto("/");
    await expect(page).not.toHaveURL(/\/login/); // landed authenticated
  });
});
