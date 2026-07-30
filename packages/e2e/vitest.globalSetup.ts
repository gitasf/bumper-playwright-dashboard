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

// Pinned VCS context for the seeded run. The reporter's `detectCI()` reads
// GITHUB_* env, which is absent locally and UNPREDICTABLE inside real GitHub
// Actions (whatever ref/sha CI happens to be on). Overriding it here makes the
// seeded runs' branch/commit deterministic everywhere, so the suite can assert
// the branch/commit filter paths against known values.
const SEEDED_BRANCH = "e2e-seeded-branch";
const SEEDED_COMMIT_SHA = "e2e5eedc0ffee000000000000000000000000000"; // 40 hex

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
        // Deterministic CI/VCS context (see SEEDED_* above). Set AFTER the
        // process.env spread so real GitHub Actions values can't leak in.
        // Empty GITHUB_HEAD_REF / GITHUB_EVENT_PATH defeat the PR-event
        // branches of the reporter's github-actions detection, so branch and
        // sha come from GITHUB_REF_NAME / GITHUB_SHA exactly.
        GITHUB_ACTIONS: "true",
        GITHUB_EVENT_PATH: "",
        GITHUB_HEAD_REF: "",
        GITHUB_REF: `refs/heads/${SEEDED_BRANCH}`,
        GITHUB_REF_NAME: SEEDED_BRANCH,
        GITHUB_SHA: SEEDED_COMMIT_SHA,
        GITHUB_REPOSITORY: "wrightful/e2e-seed",
        GITHUB_RUN_ID: "e2e-run-1",
        GITHUB_ACTOR: "e2e-bot",
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
  // The forger in e2e-context.ts signs with the dashboard's *resolved*
  // artifact secret, not the raw session secret, so they can't diverge once a
  // dedicated ARTIFACT_TOKEN_SECRET is provisioned.
  project.provide("artifactTokenSecret", fixture.artifactTokenSecret);
  project.provide("seededBranch", SEEDED_BRANCH);
  project.provide("seededCommitSha", SEEDED_COMMIT_SHA);
}

export async function teardown(): Promise<void> {
  await fixture?.teardown();
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
    seededBranch: string;
    seededCommitSha: string;
  }
}
