#!/usr/bin/env node
// Generate `wrangler.jsonc` from `wrangler.template.jsonc`, injecting the
// deployment-specific bindings from env vars — so the committed template carries
// NO account-specific IDs (see the self-hosting-generic-config rule). It's a
// generated artifact materialized from a committed template + one set of env
// knobs, run in the dev/build/deploy pre-hooks; `wrangler.jsonc` is gitignored.
//
// Env (DEPLOY-time; read from process.env first, then .env.local / .env). These
// are build-time config for `wrangler deploy` to your OWN Cloudflare account —
// NOT worker runtime vars, so they are intentionally not in env.ts:
//   CF_WORKER_NAME    worker name             (default: wrightful-dashboard-void)
//   CF_R2_BUCKET      STORAGE R2 bucket name  (block omitted if unset)
//   CF_HYPERDRIVE_ID  Hyperdrive config id    (the DB binding; omitted if unset)
//   CF_OBSERVABILITY  enable Workers Logs     (default false; block omitted unless truthy)
//
// With NO CF_* env set, the output equals the generic void-deploy fallback —
// byte-identical to the historical committed wrangler.jsonc — so `void deploy`
// and local dev are unchanged.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const at = (rel) => `${root}/${rel}`;

/**
 * Trim whitespace and strip ONE matched pair of surrounding quotes. Cloudflare
 * build variables are raw `process.env` values, and a value entered WITH quotes
 * in the CF dashboard (`"my-bucket"`) is a common mistake — left as-is it injects
 * a stray `"` into wrangler.jsonc and breaks JSONC parsing at `vp build`. The
 * `.env`-file branch already strips quotes via its regex; this normalizes the
 * process.env branch to match.
 */
function clean(value) {
  let v = value.trim();
  if (
    v.length >= 2 &&
    ((v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'")))
  ) {
    v = v.slice(1, -1).trim();
  }
  return v;
}

/** Read a var from process.env, falling back to .env.local / .env. */
function fromEnv(key) {
  const v = process.env[key];
  if (v != null && v.trim() !== "") return clean(v);
  for (const f of [".env.local", ".env"]) {
    if (!existsSync(at(f))) continue;
    // Capture the optional opening quote so we can tell quoted from unquoted
    // values: the body is everything up to a closing quote / newline.
    const m = readFileSync(at(f), "utf8").match(
      new RegExp(`^\\s*${key}\\s*=\\s*(["']?)([^"'\\n]+)`, "m"),
    );
    if (!m) continue;
    const quoted = m[1] !== "";
    let value = m[2].trim();
    // For UNQUOTED values, strip a trailing inline comment ` # …` — the
    // .env.example / SELF-HOSTING.md hints ship them and the regex would
    // otherwise capture the comment verbatim into the binding. A `#` inside
    // an explicitly quoted value is part of the value, so leave it intact.
    if (!quoted) value = value.replace(/\s+#.*$/, "").trim();
    return value;
  }
  return undefined;
}

/** Parse an env flag as a boolean (default false). Accepts true/1/yes/on. */
function fromEnvBool(key) {
  const v = fromEnv(key);
  return v != null && /^(1|true|yes|on)$/i.test(v.trim());
}

const workerName = fromEnv("CF_WORKER_NAME") || "wrightful-dashboard-void";
const r2Bucket = fromEnv("CF_R2_BUCKET");
const hyperdriveId = fromEnv("CF_HYPERDRIVE_ID");
// Local Postgres for the Hyperdrive binding. Prod resolves the DB through the
// Hyperdrive `id`; local dev (workerd) can't reach that, so it needs a direct
// connection string — otherwise `vp dev` errors out asking for
// CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE. Reuse DATABASE_URL
// (the same string local dev + migrations already use). Ignored on deploy.
const localConnectionString = fromEnv("DATABASE_URL");
const observability = fromEnvBool("CF_OBSERVABILITY");

// Own-account binding blocks — only what the env enables. Postgres binds the DB
// via `hyperdrive[HYPERDRIVE]` (id from CF_HYPERDRIVE_ID); R2 via
// `r2_buckets[STORAGE]`. Trailing commas are fine (jsonc, and the template
// already uses them before `}`). Values are emitted via JSON.stringify so any
// special character is escaped rather than corrupting the generated JSONC.
const blocks = [];
if (hyperdriveId) {
  // `localConnectionString` only takes effect in local dev; wrangler ignores it
  // when deploying (the `id` wins), so it's safe to always emit when known.
  const local = localConnectionString
    ? `, "localConnectionString": ${JSON.stringify(localConnectionString)}`
    : "";
  blocks.push(
    `  "hyperdrive": [{ "binding": "HYPERDRIVE", "id": ${JSON.stringify(hyperdriveId)}${local} }],`,
  );
}
if (r2Bucket) {
  blocks.push(
    `  "r2_buckets": [{ "binding": "STORAGE", "bucket_name": ${JSON.stringify(r2Bucket)} }],`,
  );
}
// Workers Logs (observability). Off by default — emitted only when
// CF_OBSERVABILITY is truthy. `head_sampling_rate: 1` logs 100% of requests;
// dial it down if log volume/cost becomes a concern. Not account-specific, but
// it rides the same injection marker so the committed template stays minimal.
if (observability) {
  blocks.push(
    `  "observability": { "enabled": true, "head_sampling_rate": 1 },`,
  );
}

let out = readFileSync(at("wrangler.template.jsonc"), "utf8");
out = out.replaceAll("__CF_WORKER_NAME__", workerName);
// Replace the marker line with the binding blocks (or nothing). If the marker
// is ever renamed/removed from the template, .replace would be a silent no-op
// that drops the own-account bindings while still printing success — so assert
// it's present whenever we actually have bindings to inject.
const markerRe = /^[ \t]*\/\/ __CF_OWN_ACCOUNT_BINDINGS__[ \t]*$/m;
if (blocks.length && !markerRe.test(out)) {
  throw new Error(
    "gen-wrangler: __CF_OWN_ACCOUNT_BINDINGS__ marker missing from wrangler.template.jsonc — cannot inject own-account bindings",
  );
}
out = out.replace(markerRe, blocks.join("\n"));
writeFileSync(at("wrangler.jsonc"), out);

const injected = blocks.length
  ? blocks.map((b) => b.match(/"(\w+)":/)[1]).join(", ")
  : "none (generic fallback)";
console.log(
  `✓ wrangler.jsonc (name: ${workerName}, own-account bindings: ${injected})`,
);
