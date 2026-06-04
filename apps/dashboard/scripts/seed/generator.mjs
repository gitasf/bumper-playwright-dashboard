// Synthesizes months of test-run history. Pure: give it a config + seed,
// get back a list of run payloads ready to POST at the streaming ingest API.
// Keeping the generator side-effect-free keeps it unit-testable and lets
// the seed orchestrator stay a thin loop.

import {
  buildCompleteRunPayload,
  buildOpenRunPayload,
  buildResult,
} from "@wrightful/reporter";
import {
  ACTORS,
  COMMIT_MESSAGES,
  branchesForLifecycle,
  buildTestCatalog,
  makePrng,
  sha40,
} from "./catalog.mjs";

// `makePrng` moved to catalog.mjs (the home for the synthetic-data
// primitives). Re-export it here so generator.mjs's prior public surface is
// preserved for any consumer that reached for it via this module.
export { makePrng };

const DAY_SECONDS = 86_400;

function randInt(rand, min, maxExclusive) {
  return min + Math.floor(rand() * (maxExclusive - min));
}

function pick(rand, arr) {
  return arr[Math.floor(rand() * arr.length)];
}

/**
 * Lognormal-ish duration in ms, clamped to [50, 6000]. Good enough to
 * produce a reasonable mix of fast/slow tests in the UI.
 */
function lognormalDuration(rand) {
  const u1 = Math.max(rand(), 1e-9);
  const u2 = rand();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const ms = Math.floor(Math.exp(6 + z * 0.7));
  return Math.max(50, Math.min(6000, ms));
}

function runsThisDay(rand, dayOfWeek) {
  const weekday = dayOfWeek >= 1 && dayOfWeek <= 5;
  return weekday ? randInt(rand, 6, 11) : randInt(rand, 1, 4);
}

/**
 * A PR branch lifecycle: a window of active days during which a branch
 * accumulates runs, then goes quiet (merged / abandoned).
 */
function buildPrLifecycles(rand, months) {
  const totalDays = months * 30;
  const lifecycles = [];
  let nextPrNumber = 100;
  // Roughly 2 new PR branches opened per day on average.
  for (let startDay = 0; startDay < totalDays; startDay++) {
    const opensToday =
      rand() < 0.4 ? randInt(rand, 1, 3) : rand() < 0.6 ? 1 : 0;
    for (let i = 0; i < opensToday; i++) {
      const lifespanDays = randInt(rand, 2, 8);
      lifecycles.push({
        branch: branchesForLifecycle(rand, nextPrNumber),
        prNumber: nextPrNumber,
        startDay,
        endDay: Math.min(totalDays - 1, startDay + lifespanDays),
        actor: pick(rand, ACTORS),
      });
      nextPrNumber++;
    }
  }
  return lifecycles;
}

/**
 * Pick 2–3 "incident windows" during the history where a specific test is
 * broken for 1–2 days — produces visible red spikes in the history chart
 * without wrecking the overall green-ness.
 */
function buildIncidents(rand, tests, months) {
  const totalDays = months * 30;
  const incidents = [];
  const count = randInt(rand, 2, 4);
  for (let i = 0; i < count; i++) {
    const startDay = randInt(rand, 5, totalDays - 5);
    const lengthDays = randInt(rand, 1, 3);
    const test = pick(rand, tests);
    incidents.push({
      testId: test.testId,
      startDay,
      endDay: startDay + lengthDays,
    });
  }
  return incidents;
}

function statusForTest(rand, test, dayIndex, incidents) {
  const broken = incidents.some(
    (i) =>
      i.testId === test.testId && dayIndex >= i.startDay && dayIndex < i.endDay,
  );
  if (broken) return "broken";
  const flakeRate =
    test.stability === "chronic"
      ? 0.25
      : test.stability === "occasional"
        ? 0.03
        : 0.001;
  if (rand() < flakeRate) return "flaky";
  // Tiny baseline for non-flaky tests to have a legit failure occasionally.
  if (rand() < 0.0015) return "failed";
  return "passed";
}

/**
 * Build the per-test ingest payload (attempts, status, duration, error).
 */
function buildTestResult(rand, test, logicalStatus) {
  const base = lognormalDuration(rand);
  const attempts = [];
  let resultStatus = logicalStatus;
  if (logicalStatus === "passed") {
    attempts.push({ attempt: 0, status: "passed", durationMs: base });
  } else if (logicalStatus === "flaky") {
    attempts.push({
      attempt: 0,
      status: "failed",
      durationMs: Math.floor(base * 1.1),
      errorMessage: "Timeout 5000ms exceeded.",
      errorStack: `Error: Timeout 5000ms exceeded.\n    at ${test.file}:42:5`,
    });
    const retries = randInt(rand, 1, 3);
    for (let r = 1; r <= retries; r++) {
      attempts.push({
        attempt: r,
        status: r === retries ? "passed" : "failed",
        durationMs: Math.floor(base * (r === retries ? 1 : 1.2)),
        errorMessage: r === retries ? null : "Timeout 5000ms exceeded.",
      });
    }
    resultStatus = "flaky";
  } else if (logicalStatus === "broken") {
    for (let r = 0; r < 3; r++) {
      attempts.push({
        attempt: r,
        status: "failed",
        durationMs: Math.floor(base * 1.3),
        errorMessage: `Element not found: [data-testid="${test.title.split(" ")[0]}-submit"]`,
        errorStack: `Error: Element not found\n    at ${test.file}:88:10`,
      });
    }
    resultStatus = "failed";
  } else {
    // one-off failed
    attempts.push({
      attempt: 0,
      status: "failed",
      durationMs: Math.floor(base * 1.2),
      errorMessage: "Expected 200, got 500.",
      errorStack: `Error: expected 200, got 500\n    at ${test.file}:17:3`,
    });
    resultStatus = "failed";
  }
  const totalDuration = attempts.reduce((s, a) => s + a.durationMs, 0);
  const errorAttempt = attempts.find((a) => a.status === "failed");
  // Feed the synthetic fields to the shared v3 payload builder so the seeder
  // produces the same wire shape the reporter does (filling `projectName`,
  // `workerIndex`, and the nullable error fields) rather than re-deriving it.
  return buildResult(
    {
      testId: test.testId,
      title: test.title,
      file: test.file,
      // Synthetic runs use Playwright's default (unnamed) project.
      projectName: null,
      status: resultStatus,
      durationMs: totalDuration,
      errorMessage:
        resultStatus === "failed" ? (errorAttempt?.errorMessage ?? null) : null,
      errorStack:
        resultStatus === "failed" ? (errorAttempt?.errorStack ?? null) : null,
    },
    attempts,
  );
}

/**
 * Build one run's worth of payloads. `dayStartEpoch` is the unix-seconds
 * midnight of the run's day; we stagger runs through the day so the chart
 * has per-bucket variation.
 */
function buildRun(
  rand,
  catalog,
  dayIndex,
  dayStartEpoch,
  slot,
  incidents,
  meta,
) {
  // Spread runs through the day but keep within the day's window. Jitter
  // the offset so runs don't snap to a grid.
  const secondsIntoDay = Math.min(
    DAY_SECONDS - 60,
    (slot * 1_200 + randInt(rand, 0, 1_200)) % DAY_SECONDS,
  );
  const createdAt = dayStartEpoch + secondsIntoDay;
  const activeTests = catalog.filter(
    (t) => t.birthDaysAgo >= meta.totalDays - dayIndex,
  );
  const results = activeTests.map((test) => {
    const logicalStatus = statusForTest(rand, test, dayIndex, incidents);
    return buildTestResult(rand, test, logicalStatus);
  });
  // Run duration ≈ sum / parallelism + a little jitter.
  const parallelism = 4;
  const totalMs = results.reduce((s, r) => s + r.durationMs, 0);
  const durationMs =
    Math.floor(totalMs / parallelism) + randInt(rand, 1_000, 10_000);
  const completedAt = createdAt + Math.floor(durationMs / 1000);
  const failed = results.filter(
    (r) => r.status === "failed" || r.status === "timedout",
  ).length;
  const runStatus = failed > 0 ? "failed" : "passed";
  const idempotencyKey = `seed-${meta.seed}-${dayIndex}-${slot}-${meta.branch}`;

  // Build the canonical v3 payloads via the shared builder, then layer on the
  // dev-only `createdAt` / `completedAt` backdating — the one field the seeder
  // owns that the reporter never sends (it rides the `BackdateSeconds` escape
  // hatch in the dashboard's Zod schemas, honored only in dev).
  const openPayload = {
    ...buildOpenRunPayload(
      {
        idempotencyKey,
        ciProvider: "github",
        ciBuildId: `gha-${randInt(rand, 1_000_000, 9_999_999)}`,
        branch: meta.branch,
        environment: meta.environment ?? null,
        commitSha: sha40(rand),
        commitMessage: pick(rand, COMMIT_MESSAGES),
        prNumber: meta.prNumber ?? null,
        repo: "wrightful/example-shop",
        actor: meta.actor,
        reporterVersion: "0.1.0",
        playwrightVersion: "1.59.1",
      },
      activeTests.map((t) => ({
        testId: t.testId,
        title: t.title,
        file: t.file,
        // Synthetic runs use Playwright's default (unnamed) project.
        projectName: null,
      })),
    ),
    createdAt,
  };

  // `buildResult` already sets `clientKey` to `testId`, matching the reporter.
  const resultsPayload = { results };

  const completePayload = {
    ...buildCompleteRunPayload(runStatus, durationMs),
    completedAt,
  };

  return {
    createdAt,
    completedAt,
    openPayload,
    resultsPayload,
    completePayload,
  };
}

/**
 * @typedef {{
 *   months?: number,
 *   runsPerDay?: number,
 *   seed?: string,
 *   now?: number,
 * }} GenerateOptions
 */

/**
 * Generate the full list of synthetic runs for the configured window.
 * Runs are returned in ascending createdAt order so progress output makes
 * sense and the ingest API sees a natural stream.
 *
 * @param {GenerateOptions} opts
 */
export function generateHistory(opts = {}) {
  const months = opts.months ?? 3;
  const seed = opts.seed ?? "wrightful-seed-1";
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const rand = makePrng(seed);
  const catalog = buildTestCatalog(rand);
  const totalDays = months * 30;
  const windowStart = now - totalDays * DAY_SECONDS;
  const prs = buildPrLifecycles(rand, months);
  const incidents = buildIncidents(rand, catalog, months);

  /** @type {Array<ReturnType<typeof buildRun>>} */
  const runs = [];

  for (let dayIndex = 0; dayIndex < totalDays; dayIndex++) {
    const dayStartEpoch = windowStart + dayIndex * DAY_SECONDS;
    const dayOfWeek = new Date(dayStartEpoch * 1000).getUTCDay();

    // Main branch runs
    const mainCount = opts.runsPerDay
      ? randInt(rand, Math.max(1, opts.runsPerDay - 2), opts.runsPerDay + 3)
      : runsThisDay(rand, dayOfWeek);
    for (let slot = 0; slot < mainCount; slot++) {
      runs.push(
        buildRun(rand, catalog, dayIndex, dayStartEpoch, slot, incidents, {
          branch: "main",
          actor: pick(rand, ACTORS),
          environment: "ci",
          totalDays,
          seed,
        }),
      );
    }

    // PR branch runs: each active PR on this day gets 0–2 runs.
    const activePrs = prs.filter(
      (p) => dayIndex >= p.startDay && dayIndex <= p.endDay,
    );
    for (const pr of activePrs) {
      const prRuns = rand() < 0.5 ? 1 : rand() < 0.5 ? 2 : 0;
      for (let slot = 0; slot < prRuns; slot++) {
        runs.push(
          buildRun(
            rand,
            catalog,
            dayIndex,
            dayStartEpoch,
            slot + 100,
            incidents,
            {
              branch: pr.branch,
              actor: pr.actor,
              prNumber: pr.prNumber,
              environment: "ci",
              totalDays,
              seed,
            },
          ),
        );
      }
    }
  }

  runs.sort((a, b) => a.createdAt - b.createdAt);
  return { runs, catalog, incidents };
}
