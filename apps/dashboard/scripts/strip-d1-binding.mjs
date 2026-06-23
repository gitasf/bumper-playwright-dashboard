#!/usr/bin/env node
// ⚠️ TEMPORARY WORKAROUND — DELETE ONCE FIXED UPSTREAM IN VOID. ⚠️
//
// Strips the vestigial D1 `DB` binding from the built worker config.
//
// The bug (reproduced on void@0.9.3): Void infers a `DB`/D1 binding from the
// `void/db` import rather than from the configured dialect (`dist/index.mjs`
// ~L5161/L5350), so a Postgres project (`void.json` "database": "pg") still
// emits `d1_databases: [{ binding: "DB", database_id: "local" }]` into
// `dist/ssr/wrangler.json` alongside the real `hyperdrive` binding. The
// `"local"` sentinel is fine for `vite dev` and `void deploy` (the platform
// provisions Hyperdrive and its pg deploy manifest ignores the d1 entry), but
// raw `wrangler deploy` (the own-account `deploy:cf` path) validates it and
// fails: `binding DB of type d1 must have a valid database_id [code: 10021]`.
//
// Nothing reads `env.DB` (all DB access is `void/db` -> HYPERDRIVE), so dropping
// the binding is safe; we remove only the unprovisioned `"local"` entries. Wired
// as a `postbuild` hook, so `void deploy` (which runs `vite build` directly, not
// `pnpm build`) never triggers it.
//
// TEARDOWN once Void gates the D1 binding on the dialect: delete this script +
// its `postbuild` hook and point `deploy:cf` back at `vp build`. Fixed when a pg
// build's `dist/ssr/wrangler.json` no longer carries `d1_databases`.
//   - Repro: /Users/joefairburn/void-pg-d1-repro (README is issue-ready)
//   - Upstream issue: <add link once filed>

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const wranglerJsonPath = join(
  dirname(fileURLToPath(import.meta.url)),
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
