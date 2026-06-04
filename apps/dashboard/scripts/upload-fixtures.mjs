// Runs the fixture Playwright suite in multiple scenarios against a locally
// running dashboard, using @wrightful/reporter so ingest + artifact rows
// land via the streaming path (same flow real CI uses). Seeds traces,
// videos, and screenshots in R2.
//
// Requires `.env.seed.json` from `pnpm db:seed-demo` (run automatically
// as part of `pnpm setup:local`). If the dashboard dev server isn't already
// running on :5173, this script spawns one temporarily and kills it on exit.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pc from "picocolors";
import { ensureDashboardRunning } from "./lib/dev-server.mjs";
import { startSpinner } from "./lib/spinner.mjs";
import { makePrng, sha40 } from "./seed/catalog.mjs";

const dashboardDir = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const seedPath = new URL("../.env.seed.json", import.meta.url).pathname;
const playwrightDir = new URL("./seed/playwright/", import.meta.url).pathname;

// Two callers:
//   - `setup:local` / `pnpm fixtures:generate` — reads `.env.seed.json`.
//   - The dashboard e2e suite (packages/e2e/tests-dashboard/global-setup.ts)
//     boots its own ephemeral dashboard + API key and passes both as env so
//     fixtures land against the test fixture, not the persistent demo user.
// Env wins; the seed file is the standalone fallback.
const envUrl = process.env.WRIGHTFUL_URL;
const envToken = process.env.WRIGHTFUL_TOKEN;
const envEmail = process.env.WRIGHTFUL_EMAIL;
const hasEnvCreds = envUrl && envToken;

let seed;
if (hasEnvCreds) {
  seed = { url: envUrl, apiKey: envToken, email: envEmail ?? null };
} else if (existsSync(seedPath)) {
  seed = JSON.parse(readFileSync(seedPath, "utf8"));
} else {
  console.error(
    pc.red(
      "missing .env.seed.json — run `pnpm setup:local` first, or pass " +
        "WRIGHTFUL_URL + WRIGHTFUL_TOKEN to point at an existing dashboard.",
    ),
  );
  process.exit(1);
}
const apiKey = envToken || seed.apiKey;
const QUIET = process.env.WRIGHTFUL_QUIET === "1";
const log = (...args) => {
  if (!QUIET) console.log(...args);
};

// Reachability + on-demand spawn live behind lib/dev-server.mjs so the
// readiness contract (empty-body POST /api/runs → 400 = ready) and the
// poll/spawn/signal-handler orchestration are shared with `setup:local`.
// Only the 401 remediation differs by caller, so inject it: env-mode callers
// (the e2e suite) supplied their own creds and have nothing to do with the
// seeded `.env.seed.json`.
const { baseUrl } = await ensureDashboardRunning(
  { url: envUrl || seed.url, apiKey },
  {
    onAuthRejected: (url) => {
      if (hasEnvCreds) {
        console.error(
          `dashboard at ${url} rejected the supplied API key. Re-check WRIGHTFUL_URL + WRIGHTFUL_TOKEN.`,
        );
      } else {
        console.error(
          "dashboard rejected the demo API key. Delete `.env.seed.json` and `.wrangler/state/v3/d1/` then re-run `pnpm setup:local`.",
        );
      }
      process.exit(1);
    },
  },
);

// ---------- Ensure reporter is built ----------

// Playwright loads reporters via Node's resolver, which expects the built
// entry at packages/reporter/dist/index.js. If it's missing we build it
// first rather than letting Playwright fail mid-scenario with an opaque
// module-not-found.
const stopBuildSpinner = QUIET
  ? () => {}
  : startSpinner(`  ${pc.dim("›")} ${"building reporter…".padEnd(30)} `);
const build = await new Promise((resolve) => {
  const child = spawn("pnpm", ["--filter", "@wrightful/reporter", "build"], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (d) => (stdout += d.toString()));
  child.stderr?.on("data", (d) => (stderr += d.toString()));
  child.on("exit", (code) => resolve({ status: code ?? 1, stdout, stderr }));
});
stopBuildSpinner();
if (build.status !== 0) {
  if (QUIET)
    process.stdout.write(
      `  ${pc.dim("›")} ${"building reporter…".padEnd(30)} `,
    );
  console.log(pc.red("failed"));
  process.stderr.write(build.stdout);
  process.stderr.write(build.stderr);
  process.exit(build.status);
}
log(pc.green("done"));

// ---------- Scenarios ----------

const BASE_SCENARIOS = [
  {
    label: "01-main-green",
    branch: "main",
    sha: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
    buildId: "fixture-build-01",
    includeFailures: false,
  },
  {
    label: "02-feature-flaky",
    branch: "feat/discount-codes",
    sha: "b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0",
    buildId: "fixture-build-02",
    includeFailures: true,
  },
  {
    label: "03-main-historical",
    branch: "main",
    sha: "c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9",
    buildId: "fixture-build-03",
    includeFailures: false,
  },
];

// `--volume` opts into a larger seed set so the runs-list pagination has
// enough rows to exercise multiple pages (default page size is 20). Every
// scenario is a full Playwright invocation, so this adds minutes to setup —
// keep it off the default path.
const VOLUME_COUNT = 27;
const VOLUME_BRANCHES = [
  "main",
  "feat/checkout-v2",
  "feat/auth-refresh",
  "fix/cart-race",
  "chore/deps",
  "release/1.2",
];

function volumeScenarios(count) {
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    const branch = VOLUME_BRANCHES[n % VOLUME_BRANCHES.length];
    const label = `v-${String(n).padStart(2, "0")}-${branch.replace(/[^a-z0-9]/gi, "-")}`;
    return {
      label,
      branch,
      // Deterministic per-index fake SHA: seed a PRNG from the index so the
      // volume SHAs stay stable across runs, then draw from the shared
      // synthetic-data `sha40` (one algorithm for both seed entrypoints).
      sha: sha40(makePrng(String(n))),
      buildId: `fixture-volume-${String(n).padStart(2, "0")}`,
      // Every 4th run intentionally includes failures for visual variety.
      includeFailures: n % 4 === 0,
    };
  });
}

const withVolume = process.argv.includes("--volume");
const SCENARIOS = withVolume
  ? [...BASE_SCENARIOS, ...volumeScenarios(VOLUME_COUNT)]
  : BASE_SCENARIOS;

/**
 * Run a subprocess with stdout/stderr captured. Returns exit code + merged
 * output so the caller decides whether to surface the noise (on failure) or
 * swallow it (on success).
 *
 * @returns {Promise<{ code: number, output: string }>}
 */
function runCaptured(cmd, args, opts) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...opts,
    });
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("exit", (code) => resolve({ code: code ?? 1, output }));
  });
}

async function runScenario(scenario, index, total) {
  const counter = pc.dim(`[${index + 1}/${total}]`);
  const label = `  ${counter} ${scenario.label}…`;
  // padEnd can't measure ANSI-coloured width, so pad the plain version.
  const plainLen = `  [${index + 1}/${total}] ${scenario.label}…`.length;
  const prefix = label + " ".repeat(Math.max(1, 34 - plainLen));
  const stopSpinner = startSpinner(prefix);

  const resultsDir = `${playwrightDir}test-results/${scenario.label}`;
  rmSync(resultsDir, { recursive: true, force: true });

  // Spoof GitHub Actions CI detection so the run gets stamped with branch /
  // commit / build id. The reporter reads these at onBegin, before opening
  // the run, via packages/reporter/src/ci.ts.
  //
  // Drop GITHUB_HEAD_REF and any pre-set GITHUB_* identifiers from the
  // ambient env before layering scenario values on top. When upload-fixtures
  // runs inside a PR's CI job, GitHub sets GITHUB_HEAD_REF to the PR's
  // source branch, and the reporter prefers it over GITHUB_REF_NAME — so
  // without this every scenario would inherit the PR branch instead of its
  // own (`feat/discount-codes` etc.) and the dashboard's branch filter
  // wouldn't find them.
  const {
    GITHUB_HEAD_REF: _ghHead,
    GITHUB_REF_NAME: _ghRefName,
    GITHUB_RUN_ID: _ghRunId,
    GITHUB_SHA: _ghSha,
    GITHUB_REPOSITORY: _ghRepo,
    ...envWithoutGithub
  } = process.env;
  const pwEnv = {
    ...envWithoutGithub,
    WRIGHTFUL_FIXTURE_FAILURES: scenario.includeFailures ? "1" : "0",
    PLAYWRIGHT_OUTPUT_DIR: resultsDir,
    WRIGHTFUL_URL: baseUrl,
    WRIGHTFUL_TOKEN: apiKey,
    GITHUB_ACTIONS: "true",
    GITHUB_RUN_ID: scenario.buildId,
    GITHUB_REF_NAME: scenario.branch,
    GITHUB_SHA: scenario.sha,
    GITHUB_REPOSITORY: "wrightful/example-shop",
  };

  const pw = await runCaptured(
    "npx",
    [
      "playwright",
      "test",
      "--config",
      `${playwrightDir}playwright.config.ts`,
      "--output",
      resultsDir,
    ],
    { cwd: dashboardDir, env: pwEnv },
  );

  // Playwright exits non-zero on any test failure. Scenarios that
  // *intentionally* include failures tolerate exit 1 — everything else should
  // stay green, and we bail on unexpected failures.
  if (pw.code !== 0 && !scenario.includeFailures) {
    stopSpinner();
    console.log(pc.red("failed"));
    console.error(
      `\nplaywright exited ${pw.code} on an all-green scenario — output:\n`,
    );
    process.stderr.write(pw.output);
    process.exit(pw.code);
  }

  stopSpinner();
  console.log(pc.green("done"));
}

for (let i = 0; i < SCENARIOS.length; i++) {
  await runScenario(SCENARIOS[i], i, SCENARIOS.length);
}

if (!QUIET) {
  if (seed.email) {
    console.log(pc.green(`\n✓ sign in at ${seed.url} as ${seed.email}`));
    if (baseUrl !== seed.url) {
      console.log(
        pc.dim(
          `  (fixtures were uploaded against ${baseUrl}; ${seed.url} is where \`pnpm dev\` binds)`,
        ),
      );
    }
  } else {
    console.log(pc.green(`\n✓ fixtures uploaded to ${baseUrl}`));
  }
}
