/**
 * Vitest globalSetup for the Wrightful e2e suite.
 *
 * Runs once before any test worker starts, and the corresponding teardown runs
 * once after all tests complete (even if setup or a test threw). Boots the
 * dashboard with a seeded user/team/project/API key via the shared
 * `bootDashboard` helper, then runs the Playwright demo suite to produce a
 * realistic JSON report for the CLI-upload test.
 *
 * Values needed by tests (dashboard URL, API key, session cookie, slugs, file
 * paths) are passed via project.provide() and read with inject().
 */

import { execSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { TestProject } from "vite-plus/test/node";

import { bootDashboard, type DashboardFixture } from "./src/dashboard-fixture";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const DASHBOARD_DIR = resolve(ROOT, "apps/dashboard");
const E2E_DIR = resolve(ROOT, "packages/e2e");
const REPORT_PATH = resolve(E2E_DIR, "playwright-report.json");

const PORT = 5188;

let fixture: DashboardFixture | undefined;

export async function setup(project: TestProject): Promise<void> {
  fixture = await bootDashboard({ port: PORT });

  console.log(
    "[e2e] Run Playwright with the reporter — streams a real run into the dashboard",
  );
  if (existsSync(REPORT_PATH)) unlinkSync(REPORT_PATH);
  try {
    // WRIGHTFUL_URL / WRIGHTFUL_TOKEN pick up in the reporter's onBegin;
    // playwright.config.ts is already wired to load @wrightful/reporter.
    execSync("npx playwright test", {
      cwd: E2E_DIR,
      stdio: "pipe",
      env: {
        ...process.env,
        WRIGHTFUL_URL: fixture.url,
        WRIGHTFUL_TOKEN: fixture.apiKey,
      },
    });
  } catch {
    // Some demo tests may fail — that's fine, we only need the streamed data.
  }
  if (!existsSync(REPORT_PATH)) {
    throw new Error("Playwright did not generate a JSON report");
  }

  project.provide("dashboardUrl", fixture.url);
  project.provide("apiKey", fixture.apiKey);
  project.provide("reportPath", REPORT_PATH);
  project.provide("dashboardDir", DASHBOARD_DIR);
  project.provide("sessionCookie", fixture.sessionCookie);
  project.provide("teamSlug", fixture.teamSlug);
  project.provide("projectSlug", fixture.projectSlug);
  // The forger in e2e.test.ts signs with the dashboard's *resolved* artifact
  // secret, not the raw session secret, so they can't diverge once a dedicated
  // ARTIFACT_TOKEN_SECRET is provisioned.
  project.provide("artifactTokenSecret", fixture.artifactTokenSecret);
}

export function teardown(): void {
  fixture?.teardown();
  fixture = undefined;
}

declare module "vite-plus/test" {
  export interface ProvidedContext {
    dashboardUrl: string;
    apiKey: string;
    reportPath: string;
    dashboardDir: string;
    sessionCookie: string;
    teamSlug: string;
    projectSlug: string;
    artifactTokenSecret: string;
  }
}
