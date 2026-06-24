// Guarded entry point for the dashboard UI e2e suite (`test:dashboard`).
//
// The suite boots a *real* dashboard via `bootDashboard`, which rewrites
// `apps/dashboard/.env.local` and runs `void db reset` (destructive) against
// DATABASE_URL. Run naively that has two sharp edges this wrapper removes:
//
//   1. Data loss — a `void db reset` aimed at your dev database wipes it. We
//      resolve an ISOLATED e2e database (never your dev DB) and create it if
//      missing, so the suite always resets a throwaway.
//   2. Dev-server thrash — if `pnpm dev` is running, it watches the same
//      `.env.local` this suite overwrites and gets dragged onto the e2e DB
//      mid-run. We detect a live dev server and refuse, with a clear message.
//
// Escape hatches:
//   E2E_DATABASE_URL=<url>     use this exact DB (skip derivation)
//   E2E_ALLOW_DEV_SERVER=1     run even if a dev server is up (you accept the risk)
//
// All extra CLI args are forwarded to Playwright, e.g.:
//   pnpm --filter @wrightful/e2e test:dashboard --headed test-replay

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(scriptDir, "../../..");
const E2E_DIR = resolve(scriptDir, "..");
const ENV_LOCAL = resolve(REPO_ROOT, "apps/dashboard/.env.local");
const DEV_PORT = 5173; // `pnpm dev` / setup:local; the suite itself uses 5189

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

function die(msg) {
  console.error(`\n${c.red("✖ dashboard e2e:")} ${msg}\n`);
  process.exit(1);
}

// ---- 1. resolve an isolated e2e DATABASE_URL ----------------------------

/** Read an uncommented `KEY=value` from a dotenv-shaped string. */
function readEnvValue(text, key) {
  const m = text.match(new RegExp(`^\\s*${key}=(.+)$`, "m"));
  return m ? m[1].trim() : undefined;
}

/** A DB name that's already a throwaway (e2e/test) is used as-is. */
const isThrowaway = (name) => /_(e2e|test)$/.test(name);

function resolveE2eUrl() {
  // Explicit override wins.
  if (process.env.E2E_DATABASE_URL) return process.env.E2E_DATABASE_URL;

  // Otherwise derive from DATABASE_URL or .env.local — and NEVER point at the
  // resolved base directly unless it's already a throwaway: suffix `_e2e` so a
  // dev DB can't be the reset target even if that's what's configured.
  let base = process.env.DATABASE_URL;
  if (!base && existsSync(ENV_LOCAL)) {
    base = readEnvValue(readFileSync(ENV_LOCAL, "utf8"), "DATABASE_URL");
  }
  if (!base) {
    die(
      "no DATABASE_URL found.\n" +
        "  Set DATABASE_URL, or run `pnpm setup:local` to create apps/dashboard/.env.local,\n" +
        "  or set E2E_DATABASE_URL to a dedicated test database.",
    );
  }
  let url;
  try {
    url = new URL(base);
  } catch {
    die(`DATABASE_URL is not a valid URL: ${base}`);
  }
  const name = url.pathname.replace(/^\//, "");
  if (!isThrowaway(name)) url.pathname = `/${name}_e2e`;
  return url.toString();
}

// ---- 2. ensure the e2e database exists ----------------------------------

function loadPg() {
  try {
    return require("pg");
  } catch {
    // pg is transitive (drizzle-orm/node-postgres); fall back to the pnpm store.
    try {
      const pnpm = join(REPO_ROOT, "node_modules", ".pnpm");
      const hit = readdirSync(pnpm).find((d) => /^pg@/.test(d));
      if (hit) return require(join(pnpm, hit, "node_modules", "pg"));
    } catch {
      /* ignore */
    }
  }
  return null;
}

async function ensureDatabase(e2eUrl) {
  const pg = loadPg();
  if (!pg) {
    console.log(
      c.yellow(
        "  ! pg driver not found — skipping DB auto-create (assuming it exists)",
      ),
    );
    return;
  }
  const url = new URL(e2eUrl);
  const dbName = url.pathname.replace(/^\//, "");
  // Connect to the maintenance DB on the same server to issue CREATE DATABASE.
  const admin = new URL(e2eUrl);
  admin.pathname = "/postgres";
  const client = new pg.Client({ connectionString: admin.toString() });
  try {
    await client.connect();
    await client.query(`CREATE DATABASE "${dbName}"`);
    console.log(c.green(`  ✓ created database ${dbName}`));
  } catch (err) {
    if (err && err.code === "42P04") {
      console.log(c.dim(`  • database ${dbName} already exists`));
    } else {
      // Managed Postgres (Neon etc.) may forbid connecting to `postgres` or
      // CREATE DATABASE. Don't hard-fail — the suite surfaces a clear error if
      // the DB is genuinely missing.
      console.log(
        c.yellow(
          `  ! could not auto-create ${dbName} (${err?.code || err?.message || err}); continuing`,
        ),
      );
    }
  } finally {
    await client.end().catch(() => {});
  }
}

// ---- 3. refuse to run while a dev server is live ------------------------

function probeHost(host) {
  return new Promise((res) => {
    const sock = connect({ host, port: DEV_PORT });
    const done = (up) => {
      sock.destroy();
      res(up);
    };
    sock.setTimeout(800);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

// `vp dev` binds IPv6 (`[::1]`) on macOS but IPv4 elsewhere — probe both
// loopback families so the guard can't miss a running dev server.
async function devServerUp() {
  const results = await Promise.all(["127.0.0.1", "::1"].map(probeHost));
  return results.some(Boolean);
}

// ---- run ----------------------------------------------------------------

const e2eUrl = resolveE2eUrl();
const shownUrl = e2eUrl.replace(/:\/\/([^:]+):[^@]+@/, "://$1:***@"); // mask password
console.log(c.bold("\ndashboard e2e — isolated run"));
console.log(`  database: ${c.dim(shownUrl)}`);

if (!process.env.E2E_ALLOW_DEV_SERVER && (await devServerUp())) {
  die(
    `a dev server is listening on :${DEV_PORT}.\n` +
      "  This suite rewrites apps/dashboard/.env.local + runs `void db reset`, which\n" +
      "  would drag your running `pnpm dev` onto the e2e DB and disrupt it.\n\n" +
      `  Stop the dev server first, or set ${c.bold("E2E_ALLOW_DEV_SERVER=1")} to override.`,
  );
}

await ensureDatabase(e2eUrl);

const args = [
  "playwright",
  "test",
  "--config=playwright.dashboard.config.ts",
  ...process.argv.slice(2),
];
console.log(c.dim(`  running: npx ${args.join(" ")}\n`));

const child = spawnSync("npx", args, {
  cwd: E2E_DIR,
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: e2eUrl },
});
process.exit(child.status ?? 1);
