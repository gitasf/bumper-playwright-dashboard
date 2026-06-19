#!/usr/bin/env node
// Generate `wrangler.jsonc` from `wrangler.template.jsonc`, injecting the
// deployment-specific bindings from env vars — so the committed template carries
// NO account-specific IDs (see the self-hosting-generic-config rule). This is
// the wrangler twin of apply-dialect.mjs: a generated artifact materialized from
// committed sources + one set of env knobs, run in the dev/build/deploy
// pre-hooks. `wrangler.jsonc` is gitignored, like `db/migrations/`.
//
// Env (DEPLOY-time; read from process.env first, then .env.local / .env). These
// are build-time config for `wrangler deploy` to your OWN Cloudflare account —
// NOT worker runtime vars, so they are intentionally not in env.ts:
//   CF_WORKER_NAME    worker name             (default: wrightful-dashboard-void)
//   CF_R2_BUCKET      STORAGE R2 bucket name  (block omitted if unset)
//   CF_HYPERDRIVE_ID  Hyperdrive config id    (the DB binding; omitted if unset)
//
// With NO CF_* env set, the output equals the generic void-deploy fallback —
// byte-identical to the historical committed wrangler.jsonc — so `void deploy`
// and local dev are unchanged.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const at = (rel) => `${root}/${rel}`;

/** Read a var from process.env, falling back to .env.local / .env (like apply-dialect). */
function fromEnv(key) {
  const v = process.env[key];
  if (v != null && v !== "") return v;
  for (const f of [".env.local", ".env"]) {
    if (!existsSync(at(f))) continue;
    const m = readFileSync(at(f), "utf8").match(
      new RegExp(`^\\s*${key}\\s*=\\s*["']?([^"'\\n]+)`, "m"),
    );
    if (m) return m[1].trim();
  }
  return undefined;
}

const workerName = fromEnv("CF_WORKER_NAME") || "wrightful-dashboard-void";
const r2Bucket = fromEnv("CF_R2_BUCKET");
const hyperdriveId = fromEnv("CF_HYPERDRIVE_ID");

// Own-account binding blocks — only what the env enables. Postgres binds the DB
// via `hyperdrive[HYPERDRIVE]` (id from CF_HYPERDRIVE_ID); R2 via
// `r2_buckets[STORAGE]`. Trailing commas are fine (jsonc, and the template
// already uses them before `}`).
const blocks = [];
if (hyperdriveId) {
  blocks.push(
    `  "hyperdrive": [{ "binding": "HYPERDRIVE", "id": "${hyperdriveId}" }],`,
  );
}
if (r2Bucket) {
  blocks.push(
    `  "r2_buckets": [{ "binding": "STORAGE", "bucket_name": "${r2Bucket}" }],`,
  );
}

let out = readFileSync(at("wrangler.template.jsonc"), "utf8");
out = out.replaceAll("__CF_WORKER_NAME__", workerName);
// Replace the marker line with the binding blocks (or nothing).
out = out.replace(
  /^[ \t]*\/\/ __CF_OWN_ACCOUNT_BINDINGS__[ \t]*$/m,
  blocks.join("\n"),
);
writeFileSync(at("wrangler.jsonc"), out);

const injected = blocks.length
  ? blocks.map((b) => b.match(/"(\w+)":/)[1]).join(", ")
  : "none (generic fallback)";
console.log(
  `✓ wrangler.jsonc (name: ${workerName}, own-account bindings: ${injected})`,
);
