import { defineConfig } from "@playwright/test";

// `line` reporter under CI or a CLI agent (Claude Code etc.); `list` floods
// stdout one line per test and chews through context budgets. Same idiom as
// playwright.dashboard.config.ts.
const isMinimalReporter = process.env.CI || process.env.CLAUDE;

// Streaming reporter is always configured; it no-ops if WRIGHTFUL_URL /
// WRIGHTFUL_TOKEN aren't in the environment, so local runs stay quiet while
// CI runs dogfood the full streaming path.
export default defineConfig({
  testDir: "./tests",
  reporter: [
    isMinimalReporter ? ["line"] : ["list"],
    ["json", { outputFile: "playwright-report.json" }],
    ["@wrightful/reporter"],
  ],
  retries: 1,
  use: {
    baseURL: "https://playwright.dev",
  },
});
