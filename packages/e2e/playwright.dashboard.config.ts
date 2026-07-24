import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  defineConfig,
  devices,
  type ReporterDescription,
} from "@playwright/test";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Playwright config for the dashboard UI e2e suite.
 *
 * Distinct from `playwright.config.ts` (the dogfood suite that targets
 * playwright.dev to generate streamable test data). This one drives the
 * Wrightful dashboard itself in a real browser.
 *
 * The dashboard is booted by `tests-dashboard/global-setup.ts` (which calls
 * the shared `bootDashboard` helper from `src/dashboard-fixture.ts`).
 * `storageState.json` is populated there too so every spec starts authed.
 *
 * Run locally:    pnpm --filter @wrightful/e2e test:dashboard
 * Headed/debug:   pnpm --filter @wrightful/e2e test:dashboard --headed
 */
// `line` reporter when running under CI or a CLI agent (Claude Code etc.) —
// the default reporter floods stdout with thousands of lines and chews
// through context budgets. Local interactive runs still get `list`.
const isMinimalReporter = process.env.CI || process.env.CLAUDE;

// Dogfood: stream this suite's results into a Wrightful dashboard, same as the
// demo suite (playwright.config.ts). The reporter no-ops gracefully when
// WRIGHTFUL_URL / WRIGHTFUL_TOKEN aren't set (see reporter onBegin), so local
// runs and the env-less CI leg stay quiet; set both to stream.
const dashboardReporter: ReporterDescription = ["@wrightful/reporter"];

export default defineConfig({
  testDir: "./tests-dashboard",
  testMatch: /.*\.spec\.ts/,
  // File-level parallelism only: tests within a spec keep their order on one
  // worker, while different spec files run concurrently. Every file already
  // isolates its writes (timestamped resource names, per-pid tenants,
  // throwaway sessions, unique branches), and readers of the shared runs list
  // pin to the seeded failures branch — see fixtures.ts `openSeededRun`.
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // All workers share one Void preview, database, and seeded tenant. Kept low
  // in CI: the public-repo ubuntu runner has 4 vCPUs hosting the built Worker,
  // Postgres, and every Chromium, so 2 workers is the conservative start —
  // 3 is worth benchmarking once a few 2-worker CI datapoints exist. Local
  // machines have the cores to go wider. (Validated locally at 4 workers;
  // see docs/worklog/2026-07-15-playwright-flake-hardening.md.)
  workers: process.env.CI ? 2 : 4,
  reporter: isMinimalReporter
    ? [["line"], ["html", { open: "never" }], dashboardReporter]
    : [["list"], dashboardReporter],
  globalSetup: resolve(__dirname, "tests-dashboard/global-setup.ts"),
  globalTeardown: resolve(__dirname, "tests-dashboard/global-teardown.ts"),
  expect: {
    // Sub-pixel rendering noise + tiny font hinting drift between local
    // and CI runners means a strict pixel-perfect diff is too brittle.
    // 1% tolerance catches genuine layout regressions (bar shifts, text
    // wraps, missing element) without flaking on cosmetic noise.
    toHaveScreenshot: { maxDiffPixelRatio: 0.01 },
  },
  use: {
    baseURL: "http://localhost:5189",
    storageState: "./tests-dashboard/.auth/storageState.json",
    trace: process.env.CI ? "retain-on-failure" : "on-first-retry",
    screenshot: "only-on-failure",
    // Generous under CI's shared-server load (see the workers note above); the
    // ceilings only bite when the server has genuinely stalled, not merely
    // slowed. Kept tighter locally where each test hits a responsive server.
    actionTimeout: process.env.CI ? 15_000 : 10_000,
    navigationTimeout: process.env.CI ? 25_000 : 15_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
