import { defineConfig } from "@playwright/test";

// `line` reporter under CI or a CLI agent (Claude Code etc.); same idiom as
// playwright.dashboard.config.ts. Matters most here: this config can spin up
// to 1000 generated tests, where `list`'s one-line-per-test output floods
// stdout / a CLI agent's context budget.
const isMinimalReporter = process.env.CI || process.env.CLAUDE;

export default defineConfig({
  testDir: "./tests-load",
  reporter: [isMinimalReporter ? ["line"] : ["list"], ["@wrightful/reporter"]],
  retries: 0,
  workers: Number(process.env.LOAD_TEST_WORKERS ?? "16"),
  fullyParallel: true,
});
