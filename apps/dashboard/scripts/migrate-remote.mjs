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
// It ALSO applies the void-owned Better Auth tables (`user` / `session` /
// `account` / `verification` + the MCP OAuth plugin's `oauthApplication` /
// `oauthAccessToken` / `oauthConsent`) from the committed `db/better-auth.sql`.
// Those
// tables live in `.void/better-auth-schema.ts`, NOT in `db/migrations/`, and the
// bare `void db migrate` CLI does NOT create them — only the dev server,
// `void db reset`, and `void deploy` do. Without this step an own-account
// `wrangler deploy` ships an app whose every auth call 500s with
// `relation "verification" does not exist`, and a DB/branch rebuild silently
// reintroduces it. See `db/better-auth.sql` for the full why + the upstream TODO.
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

/** Read DATABASE_URL out of a `.env.local` file's text (the fallback when no
 * `$DATABASE_URL` is set in the environment). Strips one pair of quotes. */
function parseEnvDatabaseUrl(text) {
  if (!text) return undefined;
  const m = text.match(/^\s*DATABASE_URL\s*=\s*(.+?)\s*$/m);
  if (!m) return undefined;
  return m[1].replace(/^["']|["']$/g, "");
}

// ── Better Auth tables (own-account stopgap) ────────────────────────────────
// Apply the committed, idempotent `db/better-auth.sql` (CREATE … IF NOT EXISTS)
// after the app migrations. Explicit DDL is deliberate: `drizzle-kit push` is
// non-idempotent + unsafe in CD, and `better-auth migrate` only supports the
// Kysely adapter (Void uses the drizzle adapter). See `db/better-auth.sql`.
const AUTH_TABLES = [
  "user",
  "session",
  "account",
  "verification",
  // Better Auth `mcp` OAuth plugin (see auth.ts).
  "oauthApplication",
  "oauthAccessToken",
  "oauthConsent",
];

/** Fail the deploy if Void's generated auth schema lists a table our committed
 * `db/better-auth.sql` doesn't cover — the signal to regenerate it. No-op when
 * the generated schema isn't present (e.g. `void prepare` hasn't run). */
function assertAuthSqlCoversSchema() {
  const generated = at(".void/better-auth-schema.ts");
  if (!existsSync(generated)) return;
  const tables = [
    ...readFileSync(generated, "utf8").matchAll(
      /pgTable\(\s*["'`]([^"'`]+)["'`]/g,
    ),
  ].map((m) => m[1]);
  const missing = tables.filter((t) => !AUTH_TABLES.includes(t));
  if (missing.length > 0) {
    throw new Error(
      `migrate-remote: Better Auth schema added table(s) [${missing.join(", ")}] not in db/better-auth.sql — regenerate it from .void/better-auth-schema.ts.`,
    );
  }
}

/** Apply the committed, idempotent Better Auth DDL to `connectionString`. */
async function applyBetterAuthMigrations(connectionString) {
  if (!connectionString) {
    throw new Error(
      "migrate-remote: cannot apply Better Auth tables — no DATABASE_URL resolved.",
    );
  }
  assertAuthSqlCoversSchema();
  const ddl = readFileSync(at("db/better-auth.sql"), "utf8");
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    // Multi-statement string via the simple-query protocol (no bound params).
    await client.query(ddl);
  } finally {
    await client.end();
  }
  console.log(`✓ Better Auth tables ensured (${AUTH_TABLES.join(", ")})`);
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
// The connection the Better Auth applier will use: the explicit env URL when
// set (CF Builds / CI), else the one already in `.env.local`. Same source +
// `sslrootcert=system` stripping as the `void db migrate` step above.
const envLocalUrl = parseEnvDatabaseUrl(backup);
const effectiveUrl =
  url ?? (envLocalUrl ? stripSystemRootCert(envLocalUrl) : undefined);
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
  // Then the void-owned Better Auth tables (not covered by db/migrations/).
  await applyBetterAuthMigrations(effectiveUrl);
} finally {
  // Restore the working tree's original .env.local (or remove our temp one).
  if (wroteTemp) {
    if (backup != null) writeFileSync(envLocal, backup);
    else rmSync(envLocal, { force: true });
  }
}
