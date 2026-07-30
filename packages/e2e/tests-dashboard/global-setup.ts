/**
 * Playwright globalSetup for the dashboard UI suite.
 *
 * 1. Boots the dashboard with a seeded user/team/project/API key (shared
 *    `bootDashboard` helper).
 * 2. Runs `dashboard/scripts/upload-fixtures.mjs` against that dashboard —
 *    the same canonical fixture pipeline `pnpm setup:local` uses, so the
 *    e2e suite sees the same realistic data (cart/checkout/flaky/visual
 *    across three branch scenarios) a developer running `pnpm dev` does.
 * 3. Logs in via the actual /login form once and saves `storageState.json`
 *    so every spec starts authenticated. Specs that test the unauth path
 *    explicitly clear storage in their own `test.use({ storageState: … })`.
 *
 * The fixture handle is stashed in a module-scoped variable that
 * `global-teardown.ts` reads. `globalThis` because Playwright spawns the
 * teardown in the same Node process.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, type FullConfig } from "@playwright/test";

import { bootDashboard, type DashboardFixture } from "../src/dashboard-fixture";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../../..");
const DASHBOARD_DIR = resolve(ROOT, "apps/dashboard");
const STORAGE_STATE_PATH = resolve(__dirname, ".auth", "storageState.json");
const FIXTURE_PATH = resolve(__dirname, ".auth", "fixture.json");

const PORT = 5189;

/**
 * Branch stamped on the canonical "feature with failures" fixture scenario
 * (see `dashboard/scripts/upload-fixtures.mjs` → `02-feature-flaky`). Specs
 * use this to filter the runs list down to the run carrying the visual diff.
 */
export const FAILURES_BRANCH = "feat/discount-codes";

declare global {
  // eslint-disable-next-line no-var
  var __wrightfulDashboardFixture: DashboardFixture | undefined;
}

export default async function globalSetup(_config: FullConfig): Promise<void> {
  const fixture = await bootDashboard({
    port: PORT,
    envBackupSuffix: "playwright-dashboard-backup",
    // Run synthetic monitors through the in-process StubExecutor (no Docker /
    // Void Sandbox) so monitors.spec can drive a full schedule→queue→ingest
    // cycle via the /__void dev triggers. Inert for every other spec.
    extraEnv: { WRIGHTFUL_MONITOR_EXECUTOR: "stub" },
  });
  globalThis.__wrightfulDashboardFixture = fixture;

  try {
    console.log(
      "[playwright] Seeding fixtures via upload-fixtures.mjs " +
        "(canonical scenarios — same as setup:local)",
    );
    // Reuse the local-dev fixture pipeline so the e2e suite sees the same
    // data shape a developer does. The script accepts WRIGHTFUL_URL +
    // WRIGHTFUL_TOKEN env to bypass its standard `.env.seed.json`
    // lookup. Its three scenarios produce the runs the specs assert on:
    //   01-main-green, 02-feature-flaky (visual + flaky failures),
    //   03-main-historical.
    execSync("node scripts/upload-fixtures.mjs", {
      cwd: DASHBOARD_DIR,
      stdio: "pipe",
      env: {
        ...process.env,
        WRIGHTFUL_URL: fixture.url,
        WRIGHTFUL_TOKEN: fixture.apiKey,
        WRIGHTFUL_QUIET: "1",
      },
    });

    console.log("[playwright] Building storageState from sign-up cookies");
    mkdirSync(dirname(STORAGE_STATE_PATH), { recursive: true });
    if (existsSync(STORAGE_STATE_PATH)) unlinkSync(STORAGE_STATE_PATH);

    // The sign-up step in bootDashboard returned a Set-Cookie header set
    // representing a valid Better Auth session. Inject those cookies into
    // a fresh browser context and write the resulting storageState — that
    // gives every spec a logged-in starting point without round-tripping
    // through the /login form. Specs that test the login form itself
    // explicitly drop storageState in their own `test.use({...})`.
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext();
      try {
        // Preflight each important page family against the production bundle before
        // workers start. This keeps a broken SSR route from burning minutes across
        // dozens of specs and also locates a real seeded run for detail-page checks.
        console.log("[playwright] Preflighting production SSR routes");
        const { teamSlug, projectSlug } = fixture;
        const projectBase = `/t/${teamSlug}/p/${projectSlug}`;
        const settingsBase = `/settings/teams/${teamSlug}`;
        const preflight = async (
          path: string,
          okStatuses = [200],
        ): Promise<string> => {
          const res = await context.request.get(`${fixture.url}${path}`);
          if (!okStatuses.includes(res.status())) {
            throw new Error(
              `SSR preflight GET ${path} returned ${res.status()} — the dashboard ` +
                "cannot render this route; aborting before the suite burns " +
                "minutes failing every spec that visits it",
            );
          }
          return res.text();
        };

        // Check auth pages while this context is still anonymous. Once the seeded
        // session cookies are installed, both loaders redirect to `/`.
        await preflight("/login");
        await preflight("/signup");

        const cookies = fixture.sessionCookies
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
        await context.storageState({ path: STORAGE_STATE_PATH });

        const runsListHtml = await preflight(projectBase);
        // A real seeded runId (any run works — the page module is what we're
        // checking). The tests/:id route 404s on the phantom id below;
        // navigation.spec also exercises that deliberate not-found path.
        const runId = runsListHtml.match(
          /\/runs\/([0-9A-HJKMNP-TV-Z]{26})/,
        )?.[1];
        if (!runId)
          throw new Error("SSR preflight: no run link on the runs list");
        await preflight(`${projectBase}/runs/${runId}`);
        await preflight(
          `${projectBase}/runs/${runId}/tests/01HZZZZZZZZZZZZZZZZZZZZZZZ`,
          [200, 404],
        );
        await preflight(`${projectBase}/monitors`);
        await preflight(`${projectBase}/monitors/new`);
        await preflight(settingsBase);
        await preflight(`${settingsBase}/groups`);
        await preflight(`${settingsBase}/billing`);
        await preflight(`${settingsBase}/p/${projectSlug}/keys`);
        await preflight(`/t/${teamSlug}/p/does-not-exist`, [404]);
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
    }

    // Stash fixture metadata for teardown + spec consumption (the fixture
    // object itself isn't serialisable — `teardown` is a closure).
    writeFileSync(
      FIXTURE_PATH,
      JSON.stringify(
        {
          url: fixture.url,
          apiKey: fixture.apiKey,
          teamSlug: fixture.teamSlug,
          projectSlug: fixture.projectSlug,
          betterAuthSecret: fixture.betterAuthSecret,
          artifactTokenSecret: fixture.artifactTokenSecret,
          email: fixture.email,
          password: fixture.password,
          voidProxyToken: fixture.voidProxyToken,
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch (err) {
    await fixture.teardown();
    globalThis.__wrightfulDashboardFixture = undefined;
    throw err;
  }
}
