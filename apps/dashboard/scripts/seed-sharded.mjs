// `seed:sharded` — inject ONE large, genuinely-sharded run into your running
// local dashboard so you can eyeball the run-detail "Group by → Shard" view at
// scale (e.g. 1000 tests across 8 shards → 8 shard groups).
//
// Unlike `seed:stream` (drives the real Playwright suite through the reporter,
// ~12 tests) and `fixtures:generate` / `setup:local --history` (many small
// runs), this posts a single synthetic run built by generator.mjs's
// `buildShardedRun`: N shards sharing one idempotencyKey, each carrying
// `shard {index,total}` on open + complete and per-test `shardIndex`. It drives
// the REAL sharded ingest path (expectedShards + one runShards row per shard +
// deferred worst-status finalize), not just tagged rows. The run is NOT
// backdated, so it lands at the top of the runs list.
//
// Reuses credentials + the dev-server readiness helper from `seed-stream.mjs`.
// Requires `.env.seed.json` (from `pnpm setup:local`) or WRIGHTFUL_URL +
// WRIGHTFUL_TOKEN env pointing at a running dashboard.
//
// Env:
//   SHARDED_TESTS   total tests in the run (default 1000)
//   SHARDS          number of shards to split them across (default 8)
//   SHARDED_SEED    PRNG seed for deterministic output (default sharded-seed-1)
//   WRIGHTFUL_URL / WRIGHTFUL_TOKEN   point at a specific dashboard (else
//                                     falls back to .env.seed.json).

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pc from "picocolors";
import { ensureDashboardRunning } from "./lib/dev-server.mjs";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const seedPath = new URL("../.env.seed.json", import.meta.url).pathname;

// ---------- Config ----------
const tests = Number(process.env.SHARDED_TESTS ?? "1000");
const shards = Number(process.env.SHARDS ?? "8");
const seedName = process.env.SHARDED_SEED ?? "sharded-seed-1";
if (!Number.isInteger(tests) || tests < 1) {
  console.error(
    pc.red(
      `SHARDED_TESTS must be a positive integer, got ${process.env.SHARDED_TESTS}`,
    ),
  );
  process.exit(1);
}
if (!Number.isInteger(shards) || shards < 1) {
  console.error(
    pc.red(`SHARDS must be a positive integer, got ${process.env.SHARDS}`),
  );
  process.exit(1);
}

// ---------- Credentials (env wins, else .env.seed.json) ----------
const envUrl = process.env.WRIGHTFUL_URL;
const envToken = process.env.WRIGHTFUL_TOKEN;
let seed;
if (envUrl && envToken) {
  seed = {
    url: envUrl,
    apiKey: envToken,
    teamSlug: process.env.WRIGHTFUL_TEAM ?? null,
    projectSlug: process.env.WRIGHTFUL_PROJECT ?? null,
  };
} else if (existsSync(seedPath)) {
  seed = JSON.parse(readFileSync(seedPath, "utf8"));
} else {
  console.error(
    pc.red(
      "missing .env.seed.json — run `pnpm setup:local` first, or pass " +
        "WRIGHTFUL_URL + WRIGHTFUL_TOKEN to point at a running dashboard.",
    ),
  );
  process.exit(1);
}
const apiKey = envToken || seed.apiKey;

// ---------- Ensure the dashboard is reachable ----------
// Targets the `pnpm dev` server on its fixed port (:5173) so the live run page
// you're watching receives the broadcasts — same reasoning as seed-stream.mjs.
const DEV_SERVER_URL = "http://localhost:5173";
const { baseUrl } = await ensureDashboardRunning(
  { url: envUrl ?? DEV_SERVER_URL, apiKey },
  {
    onAuthRejected: (url) => {
      console.error(
        pc.red(
          envUrl && envToken
            ? `dashboard at ${url} rejected the supplied API key — re-check WRIGHTFUL_URL + WRIGHTFUL_TOKEN.`
            : "dashboard rejected the demo API key. Delete `.env.seed.json` and re-run `pnpm setup:local`.",
        ),
      );
      process.exit(1);
    },
  },
);

// ---------- Build the reporter (always) ----------
// generator.mjs imports the v3 payload builders and StreamClient from
// @wrightful/reporter's dist. Build unconditionally (not just when missing) so a
// stale dist can't drop the new shard fields on the wire.
process.stdout.write(`${pc.dim("›")} building reporter… `);
const build = await new Promise((resolve) => {
  const child = spawn("pnpm", ["--filter", "@wrightful/reporter", "build"], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout?.on("data", (d) => (out += d.toString()));
  child.stderr?.on("data", (d) => (out += d.toString()));
  child.on("exit", (code) => resolve({ code: code ?? 1, out }));
});
if (build.code !== 0) {
  console.log(pc.red("failed"));
  process.stderr.write(build.out);
  process.exit(build.code);
}
console.log(pc.green("done"));

// ---------- Build + ingest the sharded run ----------
const { buildShardedRun } = await import("./seed/generator.mjs");
const { ingestShardedRun } = await import("./seed/ingest-runs.mjs");
const { StreamClient } = await import("@wrightful/reporter");

const run = buildShardedRun({ tests, shards, seed: seedName });
console.log(
  pc.cyan(
    `\n▶ seeding one run: ${pc.bold(tests)} tests across ${pc.bold(shards)} shards`,
  ),
);

const client = new StreamClient(baseUrl, apiKey);
const runId = await ingestShardedRun(client, run, {
  onShard: (index, total) =>
    process.stdout.write(`${pc.dim("  ›")} shard ${index}/${total} ingested\n`),
});

const runsUrl =
  seed.teamSlug && seed.projectSlug
    ? `${baseUrl}/t/${seed.teamSlug}/p/${seed.projectSlug}`
    : null;
console.log(
  pc.green(
    `\n✓ sharded run seeded (${runId}). Open the run and switch "Group by" → Shard:\n  ${
      runsUrl ?? `${baseUrl} (open your project's runs list)`
    }`,
  ),
);
