import { defineConfig } from "@playwright/test";

// Synthetic Playwright suite used by `pnpm setup:local` to seed the demo
// dashboard with realistic test results + artifacts. These specs are
// **not tests** — they don't assert anything about Wrightful itself; they
// drive the streaming reporter so ingest, R2 uploads, and per-test rows
// get exercised against a fresh local DB.
//
// `scripts/upload-fixtures.mjs` injects credentials and runs this config
// repeatedly with different CI env vars. When credentials are unset the
// reporter no-ops and writes `wrightful-fallback.json`.
export default defineConfig({
  retries: 2,
  reporter: [["list"], ["@wrightful/reporter", { artifacts: "all" }]],
  // Drop the default `{-projectName}{-platform}` suffix on snapshot file
  // names — the visual-regression spec commits a single baseline rendered
  // at seed time, and that path needs to resolve verbatim regardless of
  // which OS runs `pnpm setup:local`.
  snapshotPathTemplate: "{snapshotDir}/{testFilePath}-snapshots/{arg}{ext}",
  use: {
    // `on` (not `retain-on-failure`) so passing tests also produce a trace —
    // the seed suite exists to populate the demo dashboard with trace data to
    // browse in the viewer (Console + Network come from mock-site.ts), and the
    // all-green scenarios would otherwise ship no traces at all.
    trace: "on",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
