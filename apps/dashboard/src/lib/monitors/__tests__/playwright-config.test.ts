import { describe, expect, it } from "vite-plus/test";
import {
  generatePlaywrightConfig,
  specFilename,
} from "@/lib/monitors/playwright-config";

/**
 * `generatePlaywrightConfig` + `specFilename` (`@/lib/monitors/playwright-config`)
 * are the PURE container scaffolding the `SandboxExecutor` writes into `/work`
 * before running `npx playwright test`. They have NO `void/*` imports so they
 * are unit-testable; the executor that writes them is integration-only.
 *
 * The generated config is the load-bearing contract for the LINKING design:
 * registering `@wrightful/reporter` is what makes the in-container run stream
 * back to the dashboard attributable to its execution. These tests pin the
 * structural shape so a refactor can't silently drop the reporter registration
 * (which would make every monitor run produce no `runs` row) or flip the
 * one-check-serial invariants.
 */

describe("specFilename", () => {
  it("is a stable .spec.ts name Playwright's default testMatch selects", () => {
    expect(specFilename()).toBe("check.spec.ts");
    expect(specFilename()).toMatch(/\.spec\.ts$/);
  });
});

describe("generatePlaywrightConfig", () => {
  it("registers the given reporter module in the reporter tuple", () => {
    const config = generatePlaywrightConfig({
      reporterModule: "@wrightful/reporter",
    });
    expect(config).toContain('reporter: [["@wrightful/reporter"]]');
  });

  it("threads a non-default reporter module specifier through verbatim", () => {
    const config = generatePlaywrightConfig({
      reporterModule: "/vendor/custom-reporter.js",
    });
    expect(config).toContain('reporter: [["/vendor/custom-reporter.js"]]');
  });

  it("runs a single serial chromium check (workers 1, no retries)", () => {
    const config = generatePlaywrightConfig({
      reporterModule: "@wrightful/reporter",
    });
    expect(config).toContain("workers: 1");
    expect(config).toContain("retries: 0");
    expect(config).toContain("fullyParallel: false");
    expect(config).toContain('name: "chromium"');
  });

  it("points testDir at ./tests where the spec is written", () => {
    const config = generatePlaywrightConfig({
      reporterModule: "@wrightful/reporter",
    });
    expect(config).toContain('testDir: "./tests"');
  });

  it("sources the per-test timeout from PLAYWRIGHT_TIMEOUT_MS env with a default", () => {
    const config = generatePlaywrightConfig({
      reporterModule: "@wrightful/reporter",
    });
    expect(config).toContain(
      "timeout: Number(process.env.PLAYWRIGHT_TIMEOUT_MS) || 30000",
    );
  });

  it("does NOT inline the reporter's env-driven inputs (it reads them at runtime)", () => {
    const config = generatePlaywrightConfig({
      reporterModule: "@wrightful/reporter",
    });
    // The reporter reads these from process.env itself — baking them into the
    // config text would mean the executor couldn't vary them per execution.
    expect(config).not.toContain("WRIGHTFUL_URL");
    expect(config).not.toContain("WRIGHTFUL_TOKEN");
    expect(config).not.toContain("WRIGHTFUL_IDEMPOTENCY_KEY");
  });

  it("is importable TypeScript: defineConfig default export from @playwright/test", () => {
    const config = generatePlaywrightConfig({
      reporterModule: "@wrightful/reporter",
    });
    expect(config).toContain(
      'import { defineConfig, devices } from "@playwright/test"',
    );
    expect(config).toContain("export default defineConfig(");
  });
});
