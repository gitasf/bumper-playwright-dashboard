#!/usr/bin/env node
// ⚠️ TEMPORARY Void deploy patch — see ./README.md for the full story + teardown.
//
// Strips the vestigial D1 `DB` binding (database_id: "local") that Void emits for
// Postgres projects into dist/ssr/wrangler.json. Nothing reads `env.DB` (all DB
// access is `void/db` -> HYPERDRIVE), but a raw `wrangler deploy` rejects the
// "local" sentinel: `binding DB of type d1 must have a valid database_id
// [code: 10021]`. We drop only the unprovisioned "local" entries.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const wranglerJsonPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "dist",
  "ssr",
  "wrangler.json",
);

let raw;
try {
  raw = readFileSync(wranglerJsonPath, "utf8");
} catch {
  // No build output yet (e.g. invoked out of order). Nothing to strip — don't
  // fail the build over it.
  console.log(`[strip-d1-binding] ${wranglerJsonPath} not found — skipping.`);
  process.exit(0);
}

const config = JSON.parse(raw);
const d1 = config.d1_databases;

if (!Array.isArray(d1) || d1.length === 0) {
  console.log("[strip-d1-binding] no d1_databases binding — nothing to strip.");
  process.exit(0);
}

const kept = d1.filter((b) => b?.database_id !== "local");
const stripped = d1.length - kept.length;

if (stripped === 0) {
  console.log(
    '[strip-d1-binding] no unprovisioned (database_id: "local") d1 bindings — nothing to strip.',
  );
  process.exit(0);
}

if (kept.length === 0) delete config.d1_databases;
else config.d1_databases = kept;

writeFileSync(wranglerJsonPath, `${JSON.stringify(config, null, 2)}\n`);
console.log(
  `[strip-d1-binding] removed ${stripped} vestigial D1 binding(s) (database_id: "local") from dist/ssr/wrangler.json.`,
);
