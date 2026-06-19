import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";
import pc from "picocolors";
import { startSpinner } from "./lib/spinner.mjs";
import { startDevServerForSeed } from "./lib/dev-server.mjs";

// Local-dev bootstrap.
//
// Flow:
//   1. Create `.env.local` if missing (with a random BETTER_AUTH_SECRET,
//      ALLOW_OPEN_SIGNUP=true so the seed can call /api/auth/sign-up,
//      WRIGHTFUL_MONITOR_EXECUTOR=stub so seeded monitors run without Docker,
//      and a DATABASE_URL — the app is Postgres-only, so there's no zero-config
//      local store; missing/commented DATABASE_URL defaults to the
//      docker-compose Postgres).
//   2. Boot the local Postgres (docker-compose.pg.yml) when DATABASE_URL points
//      at localhost; a hosted URL (e.g. Neon) is assumed already-running.
//   3. `void db reset` — wipe the local database and reapply migrations.
//      Without this, Void's migration runner refuses to start if the database
//      has tables created outside its tracking (e.g. Better Auth bootstrapped
//      `account/session/user/verification` on a prior run).
//   4. Start `vp dev` and wait for the worker to respond.
//   5. Run `seed-demo.mjs` against the running server. It signs up via
//      void auth's HTTP API, creates team + project, mints an API key, and
//      seeds a few example synthetic monitors.
//   6. Optionally upload Playwright fixture data via the API key.
//   7. Optionally synthesize months of run history.

const dashboardDir = new URL("..", import.meta.url);
const envUrl = new URL(".env.local", dashboardDir);
const exampleUrl = new URL(".env.example", dashboardDir);
const seedConfigUrl = new URL(".env.seed.json", dashboardDir);

// Connection string for the docker-compose Postgres (docker-compose.pg.yml).
// setup:local writes this into .env.local when DATABASE_URL is absent and boots
// the matching container. Override DATABASE_URL (e.g. a hosted Neon branch) to
// use your own Postgres — this script then leaves the container alone.
//
// The host port defaults to 5432; export WRIGHTFUL_PG_PORT (e.g. 5433) when
// that's taken by a native Postgres — it sets the port in the DATABASE_URL we
// write for a fresh `.env.local`. `ensureLocalPostgres` then publishes the
// container on whatever port the resolved DATABASE_URL specifies (NOT a
// separately-defaulted env var), so the published port and the URL the reset
// connects to can never drift.
const PG_PORT = process.env.WRIGHTFUL_PG_PORT ?? "5432";
const LOCAL_DATABASE_URL = `postgresql://wrightful:wrightful@localhost:${PG_PORT}/wrightful_dev`;

const LABEL_WIDTH = 34;
const stageLabel = (label) => `${pc.dim("›")} ${label.padEnd(LABEL_WIDTH)} `;

/**
 * Run `label… <spinner>` in place, capturing stdout/stderr and only surfacing
 * them when the step fails. On completion, replaces the spinner with `done` /
 * `failed`. Returns the child result so callers can inspect status.
 */
async function stage(label, cmd, args, opts = {}) {
  const stop = startSpinner(stageLabel(label));
  const child = spawn(cmd, args, {
    cwd: dashboardDir,
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (d) => (stdout += d.toString()));
  child.stderr?.on("data", (d) => (stderr += d.toString()));
  const status = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code));
  });
  stop();
  if (status !== 0) {
    console.log(pc.red("failed"));
    if (stdout) process.stderr.write(stdout);
    if (stderr) process.stderr.write(stderr);
    process.exit(status ?? 1);
  }
  console.log(pc.green("done"));
  return { stdout, stderr, status };
}

// ---------- .env.local ----------

/**
 * Ensure `ALLOW_OPEN_SIGNUP=true` is set in the given `.env.local` text. The
 * seed flow needs it; without it void auth returns 403 on /api/auth/sign-up.
 *
 * Accepts both `true` and the legacy `1` shapes when probing existing files.
 *
 * @param {string} text
 * @returns {{ text: string, changed: boolean }}
 */
function ensureOpenSignup(text) {
  // Already enabled (true or 1, uncommented).
  if (/^\s*ALLOW_OPEN_SIGNUP=(true|1)\s*$/m.test(text)) {
    return { text, changed: false };
  }
  // Commented-out variant — uncomment and normalize to `true`.
  if (/^#\s*ALLOW_OPEN_SIGNUP=(?:true|1)\s*$/m.test(text)) {
    return {
      text: text.replace(
        /^#\s*ALLOW_OPEN_SIGNUP=(?:true|1)\s*$/m,
        "ALLOW_OPEN_SIGNUP=true",
      ),
      changed: true,
    };
  }
  // Missing entirely — append.
  const sep = text.endsWith("\n") ? "" : "\n";
  return { text: `${text}${sep}ALLOW_OPEN_SIGNUP=true\n`, changed: true };
}

/**
 * Ensure `WRIGHTFUL_MONITOR_EXECUTOR=stub` is set in the given `.env.local`
 * text. The dashboard defaults this to `sandbox` (a Void Sandbox container),
 * but `vp dev` runs with `dev.enable_containers=false` (wrangler.jsonc), so the
 * only executor that can actually run a seeded monitor locally is the in-process
 * stub. Without this, a scheduled monitor errors at execution time in local dev.
 *
 * Only adds the key when it's absent or commented — an explicit user value
 * (e.g. they're testing the sandbox path) is left untouched.
 *
 * @param {string} text
 * @returns {{ text: string, changed: boolean }}
 */
function ensureMonitorExecutor(text) {
  // Already set to some explicit value, uncommented — leave it.
  if (/^\s*WRIGHTFUL_MONITOR_EXECUTOR=\S+\s*$/m.test(text)) {
    return { text, changed: false };
  }
  // Commented-out variant — uncomment and normalize to `stub`.
  if (/^#\s*WRIGHTFUL_MONITOR_EXECUTOR=.*$/m.test(text)) {
    return {
      text: text.replace(
        /^#\s*WRIGHTFUL_MONITOR_EXECUTOR=.*$/m,
        "WRIGHTFUL_MONITOR_EXECUTOR=stub",
      ),
      changed: true,
    };
  }
  // Missing entirely — append.
  const sep = text.endsWith("\n") ? "" : "\n";
  return {
    text: `${text}${sep}WRIGHTFUL_MONITOR_EXECUTOR=stub\n`,
    changed: true,
  };
}

/**
 * Ensure a `DATABASE_URL` is present in `.env.local`. The dashboard is
 * Postgres-only, so local dev + migrations need a connection string (there is
 * no zero-config local store anymore). When the key is absent or commented we
 * point it at the docker-compose Postgres; an explicit value (e.g. a hosted
 * Neon URL) is left untouched.
 *
 * @param {string} text
 * @returns {{ text: string, changed: boolean }}
 */
function ensureDatabaseUrl(text) {
  // Already set to some explicit value, uncommented — leave it.
  if (/^\s*DATABASE_URL=\S+\s*$/m.test(text)) {
    return { text, changed: false };
  }
  // Commented-out variant — uncomment and point at the local compose Postgres.
  if (/^#\s*DATABASE_URL=.*$/m.test(text)) {
    return {
      text: text.replace(
        /^#\s*DATABASE_URL=.*$/m,
        `DATABASE_URL=${LOCAL_DATABASE_URL}`,
      ),
      changed: true,
    };
  }
  // Missing entirely — append.
  const sep = text.endsWith("\n") ? "" : "\n";
  return {
    text: `${text}${sep}DATABASE_URL=${LOCAL_DATABASE_URL}\n`,
    changed: true,
  };
}

/** Read an uncommented `KEY=value` from a dotenv-shaped string. */
function readEnvValue(text, key) {
  const m = text.match(new RegExp(`^\\s*${key}=(.+)$`, "m"));
  return m ? m[1].trim() : undefined;
}

let finalEnvText;
if (existsSync(envUrl)) {
  const current = readFileSync(envUrl, "utf8");
  const signup = ensureOpenSignup(current);
  const executor = ensureMonitorExecutor(signup.text);
  const database = ensureDatabaseUrl(executor.text);
  finalEnvText = database.text;
  if (signup.changed || executor.changed || database.changed) {
    writeFileSync(envUrl, finalEnvText);
    const added = [
      signup.changed && "ALLOW_OPEN_SIGNUP=true",
      executor.changed && "WRIGHTFUL_MONITOR_EXECUTOR=stub",
      database.changed && "DATABASE_URL",
    ].filter(Boolean);
    console.log(
      `${stageLabel("updating .env.local…")}${pc.yellow(
        `added ${added.join(", ")}`,
      )}`,
    );
  } else {
    console.log(
      `${stageLabel("checking .env.local…")}${pc.dim("already present")}`,
    );
  }
} else {
  const template = readFileSync(exampleUrl, "utf8");
  const randomSecret = () =>
    Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString(
      "base64",
    );
  const filled = template.replace(
    "replace-me-with-better-auth-secret",
    randomSecret(),
  );
  const { text: withSignup } = ensureOpenSignup(filled);
  const { text: withExecutor } = ensureMonitorExecutor(withSignup);
  const { text: withDatabase } = ensureDatabaseUrl(withExecutor);
  finalEnvText = withDatabase;
  writeFileSync(envUrl, finalEnvText);
  console.log(`${stageLabel("creating .env.local…")}${pc.green("done")}`);
}

const databaseUrl = readEnvValue(finalEnvText, "DATABASE_URL");

// ---------- Local Postgres ----------

/**
 * If `url` points at localhost (the docker-compose Postgres), boot the
 * container and wait for it to accept connections. A hosted URL (Neon, etc.) is
 * assumed already-running, so Docker is skipped. Exits with guidance if a local
 * DB is wanted but Docker isn't available.
 *
 * @param {string | undefined} url
 */
async function ensureLocalPostgres(url) {
  // Match localhost URLs and capture the port. The compose container MUST be
  // published on the SAME port DATABASE_URL connects to. docker-compose.pg.yml
  // publishes `${WRIGHTFUL_PG_PORT:-5432}`; if we let that default (or inherit a
  // stale value) while the URL says :5433, `docker compose up` recreates the
  // container on the wrong port and every later connection — `void db reset`,
  // `vp dev` — refuses (surfacing as a clack `■` "failed" on reset). Pinning
  // WRIGHTFUL_PG_PORT to the URL's port keeps the two in lockstep.
  const localMatch = url?.match(/@(?:localhost|127\.0\.0\.1):(\d+)/);
  if (!localMatch) {
    console.log(
      `${stageLabel("using DATABASE_URL…")}${pc.dim(
        "external Postgres (skipping Docker)",
      )}`,
    );
    return;
  }
  const port = localMatch[1];
  // `docker compose … up -d --wait` blocks until the healthcheck passes, so the
  // db reset below can connect immediately.
  const stop = startSpinner(stageLabel("starting local Postgres…"));
  const child = spawnSync(
    "docker",
    ["compose", "-f", "docker-compose.pg.yml", "up", "-d", "--wait"],
    {
      cwd: dashboardDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, WRIGHTFUL_PG_PORT: port },
    },
  );
  stop();
  if (child.error || child.status !== 0) {
    console.log(pc.red("failed"));
    const detail =
      child.error?.code === "ENOENT"
        ? "Docker isn't installed or not on PATH."
        : (child.stderr?.toString() ?? "");
    if (detail) process.stderr.write(`${detail}\n`);
    console.error(
      pc.yellow(
        "\nLocal Postgres couldn't start. Either start Docker and re-run " +
          "`pnpm setup:local`, or set DATABASE_URL in apps/dashboard/.env.local " +
          "to a hosted Postgres (e.g. a free Neon branch) and re-run.",
      ),
    );
    process.exit(child.status ?? 1);
  }
  console.log(pc.green("done"));
}

await ensureLocalPostgres(databaseUrl);

// ---------- Reset local database ----------

// Wipe the local database and reapply migrations from db/migrations/. This is
// the documented recovery path when Void's migration runner detects
// application tables without a matching `_void_migrations` history — the
// state Better Auth's bootstrap leaves behind after any previous dev run.
// Running it unconditionally makes `setup:local` idempotent: a fresh
// clone and a previously-bootstrapped workspace both end in the same
// known-good state. DATABASE_URL is passed through explicitly so the Void CLI
// targets the same Postgres `vp dev` will use. (`void db reset` runs fine
// non-interactively; if the DB is unreachable it fails here with a clack
// cancel — `ensureLocalPostgres` above guarantees the container is published
// on DATABASE_URL's port so that can't happen.)
await stage("resetting local db…", "npx", ["void", "db", "reset"], {
  env: { ...process.env, DATABASE_URL: databaseUrl },
});

// ---------- Dev server ----------

const { baseUrl, spawned: spawnedServer } = await startDevServerForSeed({
  labelWidth: LABEL_WIDTH,
});

// ---------- Seed ----------

await stage("seeding demo account…", "node", ["scripts/seed-demo.mjs"], {
  env: {
    ...process.env,
    WRIGHTFUL_QUIET: "1",
    WRIGHTFUL_URL: baseUrl,
  },
});

// ---------- Fixtures (optional) ----------

// `--history` synthesizes months of test runs via the ingest API — much
// more data than the 3 canned Playwright scenarios, at the cost of no real
// artifacts. Implies `--no-fixtures`.
const withHistory = process.argv.includes("--history");
const historyMonths = (() => {
  const i = process.argv.indexOf("--history-months");
  const v = i >= 0 ? Number(process.argv[i + 1]) : 3;
  return Number.isFinite(v) && v > 0 ? v : 3;
})();
const historySeed = (() => {
  const i = process.argv.indexOf("--history-seed");
  return i >= 0 ? (process.argv[i + 1] ?? "") : "wrightful-seed-1";
})();

const skipFixtures = process.argv.includes("--no-fixtures") || withHistory;

if (!skipFixtures) {
  if (!existsSync(seedConfigUrl)) {
    console.error(
      pc.red(
        "\n.env.seed.json is missing — seed step must have failed. Re-run `pnpm setup:local`.",
      ),
    );
    if (spawnedServer && !spawnedServer.killed) spawnedServer.kill("SIGTERM");
    process.exit(1);
  }
  const seedConfig = JSON.parse(
    readFileSync(fileURLToPath(seedConfigUrl), "utf8"),
  );

  console.log(`\n${pc.bold("generating example test data")}`);
  const fixturesArgs = ["scripts/upload-fixtures.mjs"];
  if (process.argv.includes("--volume")) fixturesArgs.push("--volume");
  const fixtures = spawnSync("node", fixturesArgs, {
    stdio: "inherit",
    cwd: dashboardDir,
    env: {
      ...process.env,
      WRIGHTFUL_QUIET: "1",
      WRIGHTFUL_URL: baseUrl,
      WRIGHTFUL_TOKEN: seedConfig.apiKey,
    },
  });

  if (fixtures.status !== 0) {
    if (spawnedServer && !spawnedServer.killed) spawnedServer.kill("SIGTERM");
    console.error(
      pc.red(
        "\nfixture generation failed — demo user still seeded. Retry with `pnpm fixtures:generate`.",
      ),
    );
    process.exit(fixtures.status ?? 1);
  }
}

// ---------- Synthesized history (optional) ----------

if (withHistory) {
  if (!existsSync(seedConfigUrl)) {
    console.error(
      pc.red(
        "\n.env.seed.json is missing — cannot seed history without the demo API key.",
      ),
    );
    if (spawnedServer && !spawnedServer.killed) spawnedServer.kill("SIGTERM");
    process.exit(1);
  }
  const seedConfig = JSON.parse(
    readFileSync(fileURLToPath(seedConfigUrl), "utf8"),
  );
  // Build the reporter first: it's loaded by Node's resolver from
  // packages/reporter/dist/index.js, and both the seeder's ingest client
  // (`StreamClient`) and its v3 payload builders (consumed by generator.mjs)
  // live there — build it before importing either so the imports don't fail
  // with an opaque module-not-found (same guard upload-fixtures.mjs uses
  // before Playwright loads the reporter).
  await stage("building reporter…", "pnpm", [
    "--filter",
    "@wrightful/reporter",
    "build",
  ]);
  const { generateHistory } = await import("./seed/generator.mjs");
  const { ingestRuns } = await import("./seed/ingest-runs.mjs");
  const { StreamClient } = await import("@wrightful/reporter");

  console.log(
    `\n${pc.bold(`generating ${historyMonths} months of history (seed=${historySeed})`)}`,
  );
  const { runs } = generateHistory({
    months: historyMonths,
    seed: historySeed,
  });
  console.log(`${stageLabel("runs to ingest…")}${pc.cyan(runs.length)}`);

  // Single-source the ingest path through the reporter's StreamClient: it
  // owns the protocol-version header, retry-on-5xx/429, Retry-After honoring,
  // and the aggressive completeRun retry. No hand-rolled HTTP client here.
  const client = new StreamClient(baseUrl, seedConfig.apiKey);

  let reportedFailures = 0;
  const startedAt = Date.now();
  const stopSpin = startSpinner(stageLabel("ingesting runs…"));
  const { completed, failed } = await ingestRuns(client, runs, {
    onError: (err) => {
      if (++reportedFailures <= 3) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`\n${pc.red("run failed")}: ${message}\n`);
      }
    },
  });
  stopSpin();
  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  if (failed > 0) {
    console.log(
      `${pc.yellow(completed)} ok, ${pc.red(failed)} failed in ${elapsedSec}s`,
    );
  } else {
    console.log(`${pc.green("done")} (${completed} runs in ${elapsedSec}s)`);
  }

  if (failed > 0) {
    if (spawnedServer && !spawnedServer.killed) spawnedServer.kill("SIGTERM");
    process.exit(1);
  }
}

// ---------- Wrap up ----------

if (spawnedServer && !spawnedServer.killed) spawnedServer.kill("SIGTERM");

console.log("");
console.log(pc.green("✓ setup complete"));
console.log(`  ${pc.dim("dashboard:")} ${baseUrl}`);
console.log(`  ${pc.dim("sign in:  ")} demo@wrightful.local / demo1234`);
console.log(
  `  ${pc.dim("monitors: ")} seeded — open Monitors in the demo project`,
);
console.log(`  ${pc.dim("run:      ")} ${pc.cyan("pnpm dev")}`);
