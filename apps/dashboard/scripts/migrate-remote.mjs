#!/usr/bin/env node
// CI/CD migration runner for `wrangler deploy` / Cloudflare Workers Builds.
//
// `void db migrate` reads DATABASE_URL ONLY from `.env.local` — it has no
// `process.env` fallback — so it can't run as-is in a CI/build environment where
// the connection comes from a build secret. This bridges that: it applies the
// committed `db/migrations/` to the REMOTE/prod Postgres using `$DATABASE_URL`
// from the ENVIRONMENT (the direct connection; Hyperdrive is runtime-only). It
// writes a temporary `.env.local` so `void db migrate` can read the URL, then
// restores the original `.env.local` (if any) — so it never disturbs local dev.
//
// Intended to run in the PRODUCTION deploy command, BEFORE `wrangler deploy`
// (migrate-before-deploy). With additive/expand migrations, a deploy that fails
// after this leaves old code serving happily on the new schema — re-run to
// recover. Destructive (contract) changes belong in a LATER deploy. See
// SELF-HOSTING.md (repo root).
import { execSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const at = (rel) => `${root}/${rel}`;
const run = (cmd) => execSync(cmd, { cwd: root, stdio: "inherit" });

/**
 * Strip the libpq `sslrootcert=system` sentinel from a Postgres URL. It means
 * "use the OS trust store" to libpq, and managed providers (PlanetScale, Neon, …)
 * hand out connection strings containing it. But node-postgres
 * (`pg-connection-string`) treats `sslrootcert` as a FILE PATH and does
 * `fs.readFileSync("system")` → `ENOENT: open 'system'`, which crashes
 * `void db migrate` at connection-string parse. Removing only the `system`
 * sentinel leaves any `sslmode` (e.g. verify-full) intact, so node verifies
 * against its built-in CA bundle — which covers those providers' public certs —
 * keeping TLS verification rather than weakening it. A real
 * `sslrootcert=/path/to/ca.pem` is left untouched.
 */
function stripSystemRootCert(raw) {
  const qIndex = raw.indexOf("?");
  if (qIndex === -1) return raw;
  const base = raw.slice(0, qIndex);
  const params = raw
    .slice(qIndex + 1)
    .split("&")
    .filter((p) => p !== "sslrootcert=system");
  return params.length ? `${base}?${params.join("&")}` : base;
}

const rawUrl = process.env.DATABASE_URL;
const url = rawUrl ? stripSystemRootCert(rawUrl) : rawUrl;
if (rawUrl && url !== rawUrl) {
  console.log(
    "migrate-remote: stripped unsupported `sslrootcert=system` from DATABASE_URL (node-postgres verifies via its built-in CA bundle).",
  );
}
const envLocal = at(".env.local");
const hadEnvLocal = existsSync(envLocal);
const backup = hadEnvLocal ? readFileSync(envLocal, "utf8") : null;
let wroteTemp = false;
try {
  if (url) {
    // Explicit prod URL from the environment wins (CF Builds / CI).
    writeFileSync(envLocal, `DATABASE_URL=${url}\n`);
    wroteTemp = true;
  } else if (!hadEnvLocal) {
    console.error(
      "migrate-remote: set DATABASE_URL (the prod Postgres connection) in the environment.",
    );
    process.exit(1);
  } else {
    console.log(
      "migrate-remote: no $DATABASE_URL; using DATABASE_URL from .env.local",
    );
  }
  run("pnpm exec void db migrate");
  console.log("✓ Postgres migrations applied (remote)");
} finally {
  // Restore the working tree's original .env.local (or remove our temp one).
  if (wroteTemp) {
    if (backup != null) writeFileSync(envLocal, backup);
    else rmSync(envLocal, { force: true });
  }
}
